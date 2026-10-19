import { DEFAULT_SETTINGS, GUARD_MAX_RUNS } from '../lib/config.js';
import { activeRuns, describeStep, emptyState, pausedSites } from '../lib/engine.js';
import { loadConfig } from '../config/store.js';
import { buildRegistry } from '../sites/build.js';

// The sites and quick links, from the config.
const config = await loadConfig();
const sites = buildRegistry(config);

const $ = (id) => document.getElementById(id);

const OUTCOMES = {
  handedOver: 'Handed over',
  signedIn: 'Signed in',
  mfa: 'Reached MFA', // logged by versions before 0.2
  stalled: 'Stopped',
  error: 'Failed',
  restarted: 'Restarted',
};

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function render() {
  const [{ settings: saved, log = [] }, session] = await Promise.all([
    chrome.storage.local.get(['settings', 'log']),
    chrome.storage.session.get([...Object.keys(emptyState()), 'trace', 'recording']),
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  const state = { ...emptyState(), ...session };

  $('status').textContent = statusText(settings, state, Date.now());
  $('no-email').hidden = Boolean(settings.email);
  $('enabled').checked = settings.enabled;
  $('dryRun').checked = settings.dryRun;
  $('dryRun').disabled = !settings.enabled;
  renderSites(settings);
  renderLog(log);
  renderTrace(session.trace ?? []);
  renderRecording(session.recording);
}

// A recording in progress (Options → Record a site). When its tab is on a host the recorder
// can't see yet, opening the popup there (which grants the extension that tab) offers to add it:
// the permission prompt has to come from a click in the extension's own pages.
async function renderRecording(recording) {
  $('recording').hidden = !recording;
  if (!recording) return;
  const steps = recording.steps.length;
  $('recording-text').textContent = `Recording ${recording.label}: ${steps} step${steps === 1 ? '' : 's'} so far. Click Done once you're signed in.`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = null;
  try {
    const url = new URL(tab?.url ?? '');
    if (tab.id === recording.tabId && url.protocol === 'https:' && url.hostname !== 'accounts.google.com' && !recording.hosts.includes(url.hostname)) host = url.hostname;
  } catch {}
  $('record-here').hidden = !host;
  if (host) {
    $('record-here').textContent = `Record on ${host} too`;
    $('record-here').dataset.host = host;
  }
}

$('record-here').addEventListener('click', async () => {
  const { host } = $('record-here').dataset;
  if (!(await chrome.permissions.request({ origins: [`https://${host}/*`] }).catch(() => false))) return;
  await chrome.runtime.sendMessage({ type: 'recordHost', host });
  window.close();
});

$('recording-cancel').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'recordingCancel' }));

// Done from here works even where the page has no bar (a site the recorder couldn't see). The
// recording tab's address, when visible, is where the site is used once signed in.
$('recording-done').addEventListener('click', async () => {
  const { recording } = await chrome.storage.session.get('recording');
  const tab = recording && (await chrome.tabs.get(recording.tabId).catch(() => null));
  await chrome.runtime.sendMessage({ type: 'recordingDone', url: tab?.url ?? '' });
  window.close();
});

function statusText(settings, state, now) {
  if (!settings.enabled) return 'Off. Switch it on to sign in automatically again.';
  const running = activeRuns(state, now);
  if (running.length) {
    return running
      .map((run) =>
        run.waitingForUser
          ? `Waiting for you on ${describeStep(run)} (${sites.label(run.site)}).`
          : `Signing in to ${sites.label(run.site)}: ${describeStep(run)}.`,
      )
      .join(' ');
  }
  const paused = pausedSites(state.starts, now);
  if (paused.length) {
    const which = paused.map(({ site, resumesAt }) => `${sites.label(site)} until ${time(resumesAt)}`).join(', ');
    return `Paused after ${GUARD_MAX_RUNS} attempts: ${which}. A sign-in page that's still open then carries on by itself.`;
  }
  const watching = sites.sites.filter((site) => !settings.disabledSites.includes(site.id)).length;
  const count = `${watching} site${watching === 1 ? '' : 's'}`;
  return settings.dryRun
    ? `Dry run, watching ${count}: it outlines what it would click instead of clicking.`
    : `On, watching ${count}. Whenever one shows its sign-in page, it signs you back in.`;
}

// The config's quick links (such as "New Google Meet"), opening in a new tab.
function renderQuickLinks() {
  $('quick-links').hidden = config.quickLinks.length === 0;
  $('quick-links').replaceChildren(
    ...config.quickLinks.map((link) =>
      Object.assign(document.createElement('a'), {
        href: link.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        textContent: link.label,
      }),
    ),
  );
}
renderQuickLinks();

// A link to each site, opening in a new tab. Opening one while signed out starts its sign-in.
function renderSites(settings) {
  $('sites').replaceChildren(
    ...sites.byLabel().map((site) => {
      const item = document.createElement('li');
      const link = Object.assign(document.createElement('a'), {
        href: site.home,
        target: '_blank',
        rel: 'noopener noreferrer',
        textContent: site.label,
      });
      item.append(link);
      for (const label of site.labels ?? []) {
        item.append(Object.assign(document.createElement('span'), { className: 'note', textContent: label }));
      }
      // Only a disabled site says so: switched off in the options, or without its access.
      const disabled = () => item.append(Object.assign(document.createElement('span'), { className: 'note', textContent: 'disabled' }));
      const access = sites.accessFor(site);
      if (settings.disabledSites.includes(site.id)) disabled();
      else if (access.length) chrome.permissions.contains({ origins: access }).then((granted) => granted || disabled());
      return item;
    }),
  );
}

function renderLog(log) {
  if (log.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = 'No runs yet.';
    $('log').replaceChildren(empty);
    return;
  }
  $('log').replaceChildren(
    ...log.map((entry) => {
      const item = document.createElement('li');
      item.className = entry.outcome;
      const when = Object.assign(document.createElement('span'), { className: 'when', textContent: time(entry.startedAt) });
      const outcome = Object.assign(document.createElement('span'), {
        className: 'outcome',
        textContent: `${sites.label(entry.site ?? 'slack')}: ${OUTCOMES[entry.outcome] ?? entry.outcome}${entry.manual ? ' (manual)' : ''}`,
      });
      const detail = Object.assign(document.createElement('span'), { className: 'detail', textContent: entry.detail });
      item.append(when, outcome, detail);
      return item;
    }),
  );
}

// "What it saw": the recent sign-in pages and what was decided, newest first.
function renderTrace(trace) {
  const describe = (entry) => {
    const who = entry.site ? sites.label(entry.site) : 'Google';
    // Site pages are labelled with the site already ("Slack's sign-in page"); Google's steps aren't.
    const what = entry.where ?? `${entry.step.replace(/^google_/, "Google's ")} page (${who})`;
    const did = entry.action === 'noop' ? 'nothing' : `${entry.action}${entry.dryRun ? ' (dry run)' : ''}`;
    return `${what}: ${did}${entry.reason ? `, ${entry.reason}` : ''}`;
  };
  $('trace').replaceChildren(
    ...(trace.length ? trace : [null]).map((entry) => {
      const item = document.createElement('li');
      if (!entry) {
        item.className = 'hint';
        item.textContent = 'Nothing yet.';
        return item;
      }
      const when = Object.assign(document.createElement('span'), {
        className: 'when',
        textContent: new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      });
      const text = Object.assign(document.createElement('span'), { className: 'detail', textContent: describe(entry) });
      item.append(when, text);
      return item;
    }),
  );
}

async function saveSetting(key, value) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings, [key]: value } });
}

for (const key of ['enabled', 'dryRun']) {
  $(key).addEventListener('change', (event) => saveSetting(key, event.target.checked));
}

$('sign-out-all').addEventListener('click', () => {
  $('sign-out-confirm').hidden = false;
  $('sign-out-all').hidden = true;
  $('sign-out-yes').focus();
});

// Record a site: the options page's record form, with this tab's address filled in (opening the
// popup lets it see the tab's address) unless it's a page no site would start from.
$('record-site').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = '';
  try {
    const address = new URL(tab?.url ?? '');
    if (address.protocol === 'https:' && !/(^|\.)google\.com$/.test(address.hostname)) url = `${address.origin}/`;
  } catch {}
  await chrome.storage.session.set({ recordRequest: { url, at: Date.now() } });
  await chrome.runtime.openOptionsPage();
  window.close();
});

$('sign-out-no').addEventListener('click', () => {
  $('sign-out-confirm').hidden = true;
  $('sign-out-all').hidden = false;
});

$('sign-out-yes').addEventListener('click', async () => {
  $('sign-out-yes').disabled = true;
  await chrome.runtime.sendMessage({ type: 'signOutAll' });
  $('sign-out-confirm').hidden = true;
  $('sign-out-all').hidden = false;
  $('sign-out-yes').disabled = false;
  $('sign-out-done').hidden = false;
  $('sign-out-done').textContent = 'Signed out of all sites. Auto sign-in is off: switch it on when you want it back.';
});

for (const link of document.querySelectorAll('[data-open-options]')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

chrome.storage.onChanged.addListener(render);
render();
