// The service worker. It owns the run state (chrome.storage.session) and the settings
// (chrome.storage.local), asks engine.js what each reported page should do, and carries
// out the side effects: badge, notifications, run log, expiry alarm and the sites'
// redirect rules. Everything site-specific comes from the definitions in src/sites/.

import { DEFAULT_SETTINGS, GOOGLE_LEAVE_GRACE_MS, LOG_SIZE } from './lib/config.js';
import {
  BADGE,
  contentError,
  decide,
  emptyState,
  expireRun,
  finishGoogleLoop,
  googleLeft,
  runActive,
  runBanner,
  tabClosed,
} from './lib/engine.js';
import { loadRegistry } from './config/store.js';
import { addHost, lastRecorded, missedPages, noteGoogle, recordedSite, recordHandover, recordStep, startRecording } from './lib/recording.js';

const RUN_ALARM = 'run-expiry:'; // + the run's tab id
const TRACE_SIZE = 30;
const BADGE_ALARM = 'badge-clear';
const ICON_URL = chrome.runtime.getURL('icons/icon128.png');
const STATUS_BADGES = { in: BADGE.SIGNED_IN, out: BADGE.SIGNED_OUT };
// The sites to sign in to, from the config. Loaded on first use and again whenever it changes.
let sitesPromise = null;
function getSites() {
  sitesPromise ??= loadRegistry();
  return sitesPromise;
}

// Messages, alarms and tab events can arrive together. Running every state change through
// one queue stops them interleaving their storage reads and writes.
let queue = Promise.resolve();
function serialized(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function getState() {
  return { ...emptyState(), ...(await chrome.storage.session.get(Object.keys(emptyState()))) };
}

async function commit({ state, effects }) {
  await chrome.storage.session.set(state);
  for (const effect of effects) await perform(effect);
  await renderBadge();
}

// "What it saw" in the popup: the recent sign-in pages and what was decided, with the reason
// when it waited or did nothing. Only the URL's host and path are kept.
async function recordTrace(url, result) {
  if (!result.trace) return;
  let where = '';
  try {
    const u = new URL(url);
    where = `${u.host}${u.pathname}`;
  } catch {}
  const { trace = [] } = await chrome.storage.session.get('trace');
  const { action } = result;
  const entry = { at: Date.now(), ...result.trace, page: where, action: action.do, dryRun: Boolean(action.dryRun), reason: action.reason ?? null };
  await chrome.storage.session.set({ trace: [entry, ...trace].slice(0, TRACE_SIZE) });
}

// The badge shows what a run is doing (…, PW, MFA, !) while that applies, and otherwise
// whether I'm signed in to the tracked site (✓) or out (✗), as last seen on its pages.
async function renderBadge() {
  const sites = await getSites();
  const { activityBadge, signedIn = {}, recording } = await chrome.storage.session.get(['activityBadge', 'signedIn', 'recording']);
  const badge = recording ? RECORDING_BADGE : activityBadge ?? STATUS_BADGES[signedIn[sites.tracked?.id]] ?? BADGE.NONE;
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.action.setBadgeText({ text: badge.text });
}

async function clearActivityBadge() {
  await chrome.storage.session.set({ activityBadge: null });
  await chrome.alarms.clear(BADGE_ALARM);
}

async function perform(effect) {
  switch (effect.type) {
    case 'badge':
      await chrome.storage.session.set({ activityBadge: effect.text ? { text: effect.text, color: effect.color } : null });
      if (effect.clearAfterMs) await chrome.alarms.create(BADGE_ALARM, { when: Date.now() + effect.clearAfterMs });
      else await chrome.alarms.clear(BADGE_ALARM);
      return;
    case 'notify':
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: ICON_URL,
        title: 'Auto sign-in',
        message: effect.message,
      });
      return;
    case 'log': {
      const { log = [] } = await chrome.storage.local.get('log');
      await chrome.storage.local.set({ log: [effect.entry, ...log].slice(0, LOG_SIZE) });
      return;
    }
    case 'alarm':
      await chrome.alarms.create(`${RUN_ALARM}${effect.tabId}`, { when: effect.when });
      return;
    case 'clearAlarm':
      await chrome.alarms.clear(`${RUN_ALARM}${effect.tabId}`);
      return;
    case 'navigate':
      await chrome.tabs.update(effect.tabId, { url: effect.url }).catch(() => {});
      return;
    default:
      console.warn('Auto sign-in: unknown effect', effect);
  }
}

// The Google loop's tab left a Google sign-in page (see engine.js, googleLeft): after a
// moment, see where the tab went.
async function settleGoogleLeave(tabId, leftAt) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // tab.url is only visible for sites in host_permissions, so a hidden URL means it left Google.
  const url = tab?.url ?? '';
  const where = !tab
    ? 'gone'
    : url.startsWith('https://accounts.google.com/')
      ? 'google'
      : url.startsWith('https://myaccount.google.com/')
        ? 'googleAccount'
        : 'elsewhere';
  await serialized(async () =>
    commit(finishGoogleLoop({ state: await getState(), tabId, leftAt, now: Date.now(), where, settings: await getSettings() })),
  );
}

// "Sign out of all" in the popup: clear every site's cookies (without reading them), end any
// runs, and switch auto sign-in off so open tabs don't sign straight back in.
async function signOutAll() {
  const sites = await getSites();
  await chrome.browsingData.remove({ origins: sites.origins() }, { cookies: true });
  await serialized(async () => {
    const state = await getState();
    const signedIn = sites.tracked ? { [sites.tracked.id]: 'out' } : {};
    await chrome.storage.session.set({ runs: {}, signedIn });
    await chrome.alarms.clearAll();
    const settings = await getSettings();
    await chrome.storage.local.set({ settings: { ...settings, enabled: false } });
    await clearActivityBadge();
    await renderBadge();
    return state;
  });
  return { signedOut: sites.sites.map((site) => site.label) };
}

// The content script on site pages is registered at runtime, for the pages of every site whose
// host access has been granted (Google's pages have the manifest's own content script). Run one
// sync at a time, so overlapping calls can't register the same script twice.
const SITE_SCRIPTS_ID = 'site-pages';
let scriptsQueue = Promise.resolve();
function syncContentScripts() {
  scriptsQueue = scriptsQueue.then(registerSiteScripts, registerSiteScripts);
  return scriptsQueue;
}

async function registerSiteScripts() {
  const sites = await getSites();
  const matches = [];
  for (const site of sites.sites) {
    const access = sites.accessFor(site);
    if (access.length && (await chrome.permissions.contains({ origins: access }))) matches.push(...site.matches);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SITE_SCRIPTS_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SITE_SCRIPTS_ID] });
  if (matches.length === 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: SITE_SCRIPTS_ID,
      matches: [...new Set(matches)],
      js: chrome.runtime.getManifest().content_scripts[0].js,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

// --- Recording a new site (src/lib/recording.js, src/content/recorder.js) ---
// One recording at a time, in its own tab, kept in chrome.storage.session. While it lasts, that
// tab is never signed in automatically: I sign in by hand and the recorder notes what I do.
const RECORDER_ID = 'recorder';
const RECORDER_JS = ['src/content/selectors.js', 'src/content/dom.js', 'src/content/locate.js', 'src/content/recorder.js'];
const RECORDING_BADGE = { text: 'REC', color: '#c62828' };
// Access to every site while recording ("follow the sign-in"), given back when it ends.
const EVERY_SITE = 'https://*/*';

async function getRecording() {
  return (await chrome.storage.session.get('recording')).recording ?? null;
}

// The recorder is registered for the recording's hosts, so it's on every page the tab loads there.
async function registerRecorder(hosts) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [RECORDER_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [RECORDER_ID] });
  if (!hosts.length) return;
  await chrome.scripting.registerContentScripts([
    { id: RECORDER_ID, matches: hosts.map((host) => `https://${host}/*`), js: RECORDER_JS, runAt: 'document_idle', persistAcrossSessions: false },
  ]);
}

// Called inside serialized(), so the recording exists before the tab's first page asks about it.
// follow: the options page was granted access to every site for this recording, so the recorder
// can follow the sign-in onto any host (an identity provider, the app on another domain).
async function beginRecording({ url, label, follow }) {
  const previous = await getRecording();
  if (previous) await endRecording(previous);
  const host = new URL(url).hostname;
  await registerRecorder([host]);
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ recording: { ...startRecording({ tabId: tab.id, label, url, now: Date.now() }), follow }, recorded: null });
  await renderBadge();
}

// The recording is over (done, cancelled or its tab closed). Access to every site goes back;
// saving the recorded site asks for its own hosts.
async function endRecording(recording, recorded = null) {
  await chrome.storage.session.set({ recording: null, recorded });
  await registerRecorder([]);
  if (recording?.follow) await chrome.permissions.remove({ origins: [EVERY_SITE] }).catch(() => false);
  await renderBadge();
}

// The recorder joins a host the tab went on to (an identity provider's sign-in, say).
async function coverHost(recording, host) {
  const next = { ...addHost(recording, host), blocked: false };
  await chrome.storage.session.set({ recording: next });
  await registerRecorder(next.hosts);
  await chrome.scripting.executeScript({ target: { tabId: next.tabId }, files: RECORDER_JS }).catch(() => {});
}

// The recording tab loaded a page. tab.url is only visible on hosts the extension has access to:
// a new one of those gets the recorder straight away. On any other host the recorder can't run
// until I allow it, which needs a click in the extension's own pages, so the popup offers it.
async function followRecordingTab(recording, tab) {
  if (!tab.url) {
    if (recording.blocked) return;
    await chrome.storage.session.set({ recording: { ...missedPages(recording), blocked: true } });
    await perform({
      type: 'notify',
      message: `Recording ${recording.label}: the extension can't see this page's site yet. Click the extension's icon to record it too.`,
    });
    return;
  }
  const url = new URL(tab.url);
  // Google's pages count even where its content script doesn't run (sign-ins Google waves through).
  if (url.hostname === 'accounts.google.com') {
    await chrome.storage.session.set({ recording: { ...noteGoogle(recording, { url: tab.url }), blocked: false } });
    return;
  }
  if (url.protocol !== 'https:' || recording.hosts.includes(url.hostname)) {
    if (recording.blocked) await chrome.storage.session.set({ recording: { ...recording, blocked: false } });
    return;
  }
  if (await chrome.permissions.contains({ origins: [`https://${url.hostname}/*`] })) await coverHost(recording, url.hostname);
}

async function syncRules() {
  const sites = await getSites();
  const settings = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: settings.enabled ? sites.sites.flatMap((site) => site.rules?.(settings) ?? []) : [],
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  let reply;
  switch (message?.type) {
    case 'elements':
      // Plain data, so it survives being sent to the content script.
      reply = getSites().then((sites) => sites.forUrl(message.url)?.elements ?? {});
      break;
    case 'page':
      reply = serialized(async () => {
        const recording = await getRecording();
        // The recording tab, or a pop-up it opened (some sites sign in to Google in one).
        if (recording && (recording.tabId === tabId || sender.tab?.openerTabId === recording.tabId)) {
          // Signing in by hand while recording: note Google's page, and do nothing.
          const { url, markers = {} } = message.signals ?? {};
          if (String(url).startsWith('https://accounts.google.com/')) {
            const app = String(markers.continueTo ?? markers.consentApp ?? '').trim();
            await chrome.storage.session.set({ recording: noteGoogle(recording, { url, appName: app }) });
            // The recorder's bar isn't on Google's pages, so say why: this is the site's single
            // sign-on through Google, which every sign-in does by itself.
            return {
              do: 'recordingBanner',
              text: `Recording ${recording.label}: this is Google's single sign-on${app ? ` for ${app}` : ''}. The extension does this part itself on every sign-in (picking your account, then Continue or Allow), so it isn't recorded. Do it by hand this once; the recording carries on when you're back on the site.`,
            };
          }
          return { do: 'noop', reason: 'recording a sign-in in this tab' };
        }
        const now = Date.now();
        const sites = await getSites();
        const result = decide({ signals: message.signals, tabId, state: await getState(), settings: await getSettings(), now, sites });
        await commit(result);
        await recordTrace(message.signals?.url, result);
        // The page says a sign-in is under way (or how it ended, on the page where it did), for as
        // long as runBanner() says.
        const run = result.state.runs[tabId];
        const shown = run && (runActive(run, now) || (run.ended && run.endedAt === now)) ? run : null;
        const banner = runBanner(shown, sites, now);
        return banner ? { ...result.action, banner } : result.action;
      });
      break;
    case 'error':
      reply = serialized(async () =>
        commit(contentError({ state: await getState(), tabId, message: String(message.message), now: Date.now(), sites: await getSites() })),
      );
      break;
    case 'signOutAll':
      reply = signOutAll();
      break;
    case 'startRecording':
      // From the options page, after it was granted access to the site's host.
      reply = serialized(() => beginRecording({ url: String(message.url), label: String(message.label), follow: Boolean(message.follow) }));
      break;
    case 'recorderHello':
      // The email is filled in to the site's email boxes while recording, as a sign-in would.
      reply = Promise.all([getRecording(), getSettings()]).then(([recording, settings]) =>
        recording?.tabId === tabId
          ? { recording: true, label: recording.label, count: recording.steps.length, email: settings.email }
          : { recording: false },
      );
      break;
    case 'recordStep':
    case 'recordHandover':
      reply = serialized(async () => {
        const recording = await getRecording();
        if (!recording || recording.tabId !== tabId) return null;
        const next = message.type === 'recordStep' ? recordStep(recording, message) : recordHandover(recording, message);
        await chrome.storage.session.set({ recording: next });
        return { count: next.steps.length, last: lastRecorded(next) };
      });
      break;
    case 'recordingDone':
      // From the recording tab's bar, or from the popup (no tab).
      reply = serialized(async () => {
        const recording = await getRecording();
        if (!recording || (tabId !== undefined && recording.tabId !== tabId)) return;
        await endRecording(recording, recordedSite(recording, { doneUrl: String(message.url ?? '') }));
        await chrome.runtime.openOptionsPage();
      });
      break;
    case 'recordingCancel':
      // From the recording tab's bar, or from the popup (no tab).
      reply = serialized(async () => {
        const recording = await getRecording();
        if (recording && (tabId === undefined || recording.tabId === tabId)) await endRecording(recording);
      });
      break;
    case 'recordHost':
      // From the popup, after it was granted access to the host the recording tab is on.
      reply = serialized(async () => {
        const recording = await getRecording();
        if (recording) await coverHost(recording, String(message.host));
      });
      break;
    case 'leftGoogle':
      reply = serialized(async () => {
        const result = googleLeft({ state: await getState(), tabId, now: Date.now(), sites: await getSites() });
        await commit(result);
        if (result.leftAt) setTimeout(() => settleGoogleLeave(tabId, result.leftAt), GOOGLE_LEAVE_GRACE_MS);
      });
      break;
    default:
      return false;
  }
  reply.then(
    (value) => sendResponse(value ?? null),
    (error) => {
      console.error('Auto sign-in:', error);
      sendResponse({ do: 'noop' });
    },
  );
  return true; // keep the channel open for the async reply
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(RUN_ALARM)) {
    const tabId = Number(alarm.name.slice(RUN_ALARM.length));
    serialized(async () => commit(expireRun({ state: await getState(), tabId, now: Date.now(), sites: await getSites() })));
  } else if (alarm.name === BADGE_ALARM) {
    serialized(async () => {
      await clearActivityBadge();
      await renderBadge();
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete') return;
  serialized(async () => {
    const recording = await getRecording();
    if (recording?.tabId === tabId) await followRecordingTab(recording, tab);
    // Google's sign-in in a pop-up window opened from the recording tab is part of the recording.
    else if (recording && tab.openerTabId === recording.tabId && tab.url?.startsWith('https://accounts.google.com/')) {
      await chrome.storage.session.set({ recording: noteGoogle(recording, { url: tab.url }) });
    }
  });
});

// A closed tab's run can't go anywhere: end it, so it doesn't hold up its site. Closing the
// recording tab cancels the recording.
chrome.tabs.onRemoved.addListener((tabId) => {
  serialized(async () => {
    const recording = await getRecording();
    if (recording?.tabId === tabId) await endRecording(recording);
    const state = await getState();
    if (!state.runs[tabId]) return;
    await commit(tabClosed({ state, tabId, now: Date.now() }));
    await chrome.alarms.clear(`${RUN_ALARM}${tabId}`);
  });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Approved apps, from versions that asked before the first Continue/Allow (0.4 to 0.7).
  await chrome.storage.local.remove('trustedApps');
  await syncRules();
  await syncContentScripts();
  for (const site of (await getSites()).sites) {
    // Pages open before an install or reload keep the old, disconnected content script.
    // Reload the ones the site says have nothing to lose, so they pick up the new one.
    if (site.reloadOnInstall) {
      for (const tab of await chrome.tabs.query({ url: site.reloadOnInstall })) chrome.tabs.reload(tab.id);
    }
    // The reload also cleared the signed-in status. An open tab on a signed-in-only page
    // (a signed-out one would have gone to the sign-in page) means signed in.
    if (site.signedInTabs && (await chrome.tabs.query({ url: site.signedInTabs })).length > 0) {
      await serialized(async () => {
        const { signedIn = {} } = await chrome.storage.session.get('signedIn');
        await chrome.storage.session.set({ signedIn: { ...signedIn, [site.id]: 'in' } });
        await renderBadge();
      });
    }
  }
  if (reason === 'install' && !(await getSettings()).email) chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  syncRules();
  syncContentScripts();
});

// Granting or removing a site's access changes where the content script runs.
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.config) {
    sitesPromise = null;
    syncRules();
    syncContentScripts();
  }
  if (!changes.settings) return;
  syncRules();
  // Switched off: drop any run badge, but keep showing whether I'm signed in.
  if (changes.settings.newValue?.enabled === false) {
    serialized(async () => {
      await clearActivityBadge();
      await renderBadge();
    });
  }
});
