// Decides what happens at each step of a sign-in run. Nothing here touches chrome.*,
// so the whole flow can be unit tested. Each entry point takes the stored state and
// returns { state, effects } (decide() also returns the action for the content script);
// background.js saves the state and carries out the effects.
//
// What each site's pages are comes from its definition in src/sites/. This file handles
// what's shared: runs, Google's sign-in pages, the loop guard and the signed-in status.
//
// Each tab has at most one run, and each site at most one run at a time: sign-ins to
// different sites go ahead side by side, while a second tab for the same site waits.

import {
  RUN_WINDOW_MS,
  WAIT_WINDOW_MS,
  GUARD_MAX_RUNS,
  GUARD_WINDOW_MS,
  BADGE_CLEAR_MS,
  OTHER_TAB_RETRY_MS,
} from './config.js';
import { STEP } from './steps.js';

export { STEP };

export const BADGE = Object.freeze({
  NONE: { text: '', color: '#000000' },
  RUNNING: { text: '…', color: '#1d6fd8' },
  WAITING: { text: 'PW', color: '#b26a00' },
  HANDOVER: { text: 'MFA', color: '#2a8a4a' },
  PROBLEM: { text: '!', color: '#c62828' },
  // Shown when no run badge applies.
  SIGNED_IN: { text: '✓', color: '#2a8a4a' },
  SIGNED_OUT: { text: '✗', color: '#6b6b6b' },
});

const noop = (reason) => (reason ? { do: 'noop', reason } : { do: 'noop' });
const WAIT_VISIBLE = Object.freeze({ do: 'waitVisible', reason: 'waiting for you to look at the tab' });

// Pages where I have to type something, so the run window stretches.
const WAITING_STEPS = new Set([STEP.GOOGLE_PASSWORD, STEP.GOOGLE_CHALLENGE]);

// Steps that only lead to a site's sign-in page. If none appears I was probably
// already signed in, so a run that stalls here ends without a warning.
const QUIET_STEPS = new Set([STEP.REDIRECT]);

// Ended runs stay in the state this long, so the popup can still show them briefly.
const KEEP_ENDED_MS = 60_000;

const STEP_LABELS = {
  [STEP.GOOGLE_CHOOSER]: "Google's account chooser",
  [STEP.GOOGLE_VERIFY]: `Google's "Verify that it's you" page`,
  [STEP.GOOGLE_IDENTIFIER]: "Google's email page",
  [STEP.GOOGLE_PASSWORD]: "Google's password page",
  [STEP.GOOGLE_CHALLENGE]: "Google's 2-Step page",
  [STEP.GOOGLE_CONSENT]: "Google's Continue/Allow page",
};

// Where a run is, for messages: the site page's own label, or the Google step's.
export function describeStep(run) {
  return run?.where ?? STEP_LABELS[run?.step] ?? 'an unknown page';
}

// How long each kind of banner stays. Pages often don't change when a sign-in moves on or ends (an
// app that shows itself after the code without loading a page), so none stays for good: a step's
// banner is a brief sign on each page, and one that's over to me stays until I type or click.
export const BANNER_MS = Object.freeze({ step: 2_000, waiting: 60_000, signedIn: 6_000, handedOver: 30_000, stopped: 30_000 });

// The banner a page shows while the extension signs me in, so it's clear it's under way, from the
// site's sign-in through Google's pages to the end: { text, hideAfterMs, hideOnInput }, or null.
// now: when the page reported; the step is only named on the page where it happened (the run moved
// on just then), not on one it led to that isn't a step of its own (an app's first page).
export function runBanner(run, sites, now = run?.lastStepAt) {
  if (!run) return null;
  const label = sites.label(run.site);
  const where = describeStep(run);
  // The site's own pages are named after it ("Acme's sign-in page"): no need to say Acme twice.
  const step = where.startsWith(`${label}'s `) ? where.slice(label.length + 3) : where;
  if (run.ended) {
    if (run.outcome === 'signedIn') return { text: `Auto sign-in: signed in to ${label}.`, hideAfterMs: BANNER_MS.signedIn };
    if (run.outcome === 'handedOver') return { text: `Auto sign-in: over to you on ${where}.`, hideAfterMs: BANNER_MS.handedOver, hideOnInput: true };
    if (run.outcome === 'stalled' || run.outcome === 'error') {
      return { text: `Auto sign-in stopped at ${where}. Finish signing in by hand.`, hideAfterMs: BANNER_MS.stopped, hideOnInput: true };
    }
    return null;
  }
  if (run.waitingForUser) {
    return { text: `Auto sign-in: signing in to ${label}, waiting for you on ${where}.`, hideAfterMs: BANNER_MS.waiting, hideOnInput: true };
  }
  const here = run.lastStepAt === now;
  return { text: `Auto sign-in: signing in to ${label}${here ? ` · ${step}` : ''}…`, hideAfterMs: BANNER_MS.step };
}

// runs: { tabId: run }. signedIn: { siteId: 'in' | 'out' } for sites with tracksSignIn, as last seen.
export function emptyState() {
  return { runs: {}, starts: {}, guardNotifiedAt: {}, signedIn: {} };
}

export function classifyGoogle(url, markers = {}) {
  if (url.hostname !== 'accounts.google.com') return null;
  const path = url.pathname;
  if (path.startsWith('/v3/signin/challenge/pwd')) return STEP.GOOGLE_PASSWORD;
  if (path.startsWith('/v3/signin/challenge/')) return STEP.GOOGLE_CHALLENGE;
  if (path.startsWith('/v3/signin/accountchooser')) return STEP.GOOGLE_CHOOSER;
  if (path.startsWith('/v3/signin/identifier')) return STEP.GOOGLE_IDENTIFIER;
  if (path.startsWith('/signin/oauth/')) return STEP.GOOGLE_CONSENT;
  // Pages not seen in a real flow yet. A visible password box wins, so the
  // extension waits for me rather than clicking Next past it.
  if (markers.googlePassword) return STEP.GOOGLE_PASSWORD;
  if (markers.googleVerify) return STEP.GOOGLE_VERIFY;
  if (markers.googleEmailInput) return STEP.GOOGLE_IDENTIFIER;
  return null;
}

// Whether a Google sign-in page belongs to this site's run: something the site names in Google's
// URL (usually its host, in the redirect address), or its app name in the "to continue to …" line.
export function googleFlowIsFor(site, url, continueTo) {
  const address = url.toLowerCase();
  const appName = (continueTo ?? '').toLowerCase();
  const mentioned = site.google.mentions.some((text) => address.includes(text.toLowerCase()));
  return mentioned || site.google.appNames.some((name) => appName.includes(name.toLowerCase()));
}

// A sign-in to Google itself (Gmail, Drive, Google's own pages), as opposed to "Sign in with
// Google" for another app: no OAuth client, SAML request or redirect address in the URL, and
// if it says where it continues to, that's a Google site.
export function isGoogleOwnSignIn(url) {
  if (/client_id|redirect_uri|saml2|\/o\/oauth2|signin\/oauth/i.test(url.href)) return false;
  const next = url.searchParams.get('continue');
  if (!next) return true;
  try {
    const host = new URL(next).hostname;
    return /(^|\.)(google\.com|youtube\.com)$/.test(host);
  } catch {
    return false;
  }
}

export function runActive(run, now) {
  if (!run || run.ended) return false;
  return now - run.lastStepAt < (run.waitingForUser ? WAIT_WINDOW_MS : RUN_WINDOW_MS);
}

// The active run in this tab, if any.
export function tabRun(state, tabId, now) {
  const run = state.runs?.[tabId];
  return runActive(run, now) ? run : null;
}

// Every active run, for the popup.
export function activeRuns(state, now) {
  return Object.values(state.runs ?? {}).filter((run) => runActive(run, now));
}

// An active run for this site in another tab.
function siteBusyElsewhere(state, siteId, tabId, now) {
  return activeRuns(state, now).find((run) => run.site === siteId && run.tabId !== tabId) ?? null;
}

function pruneRuns(runs = {}, now) {
  return Object.fromEntries(
    Object.entries(runs).filter(([, run]) => runActive(run, now) || (run.ended && now - run.endedAt < KEEP_ENDED_MS)),
  );
}

// The loop guard's record: { siteId: [start times] }, keeping only the last GUARD_WINDOW_MS.
export function pruneStarts(starts = {}, now) {
  const kept = {};
  for (const [site, times] of Object.entries(starts)) {
    const recent = times.filter((t) => now - t < GUARD_WINDOW_MS);
    if (recent.length) kept[site] = recent;
  }
  return kept;
}

// When the loop guard lets a site's automatic runs start again: once its oldest counted run ages out.
export function guardResumesAt(times) {
  return Math.min(...times) + GUARD_WINDOW_MS;
}

// Sites whose automatic runs are paused, for the popup.
export function pausedSites(starts, now) {
  return Object.entries(pruneStarts(starts, now))
    .filter(([, times]) => times.length >= GUARD_MAX_RUNS)
    .map(([site, times]) => ({ site, resumesAt: guardResumesAt(times) }));
}

function newRun({ tabId, now, site }) {
  return {
    site,
    tabId,
    startedAt: now,
    lastStepAt: now,
    step: null,
    where: null,
    siteConfirmed: false,
    waitingForUser: false,
    ended: false,
  };
}

function freshResult(state, now) {
  const base = { ...emptyState(), ...state };
  return {
    action: noop(),
    state: { ...base, runs: pruneRuns(base.runs, now), starts: pruneStarts(base.starts, now) },
    effects: [],
  };
}

function setRun(result, run) {
  result.state.runs = { ...result.state.runs, [run.tabId]: run };
}

function expiryAlarm(run) {
  return {
    type: 'alarm',
    tabId: run.tabId,
    when: run.lastStepAt + (run.waitingForUser ? WAIT_WINDOW_MS : RUN_WINDOW_MS) + 1000,
  };
}

function endRun(result, run, outcome, detail, now) {
  setRun(result, { ...run, ended: true, outcome, endedAt: now });
  result.effects.push(
    { type: 'clearAlarm', tabId: run.tabId },
    {
      type: 'log',
      entry: {
        site: run.site,
        startedAt: run.startedAt,
        endedAt: now,
        lastStep: run.step,
        outcome,
        detail,
      },
    },
  );
}

// A run that got me signed in (or handed over) proves the site's flow isn't stuck,
// so its earlier attempts stop counting towards the loop guard.
function succeeded(result, site) {
  const { [site]: _starts, ...starts } = result.state.starts;
  const { [site]: _notified, ...notified } = result.state.guardNotifiedAt;
  result.state.starts = starts;
  result.state.guardNotifiedAt = notified;
}

function pause(result, site, now) {
  // One notification per guard window is plenty.
  if (now - (result.state.guardNotifiedAt[site.id] ?? 0) < GUARD_WINDOW_MS) return;
  result.state.guardNotifiedAt = { ...result.state.guardNotifiedAt, [site.id]: now };
  const resumesAt = guardResumesAt(result.state.starts[site.id]);
  result.effects.push(
    {
      type: 'notify',
      message: `Paused ${site.label} after ${GUARD_MAX_RUNS} sign-in attempts in ${GUARD_WINDOW_MS / 60_000} minutes. Sign in by hand this time.`,
    },
    // The warning goes when automatic sign-in comes back.
    { type: 'badge', ...BADGE.PROBLEM, clearAfterMs: Math.max(resumesAt - now, 1000) },
  );
}

// Checks shared by everything that starts a run: another tab already signing in to the
// site, then the loop guard. Returns false (with result.action set) if the run can't start.
function mayStart(result, site, tabId, now) {
  const busy = siteBusyElsewhere(result.state, site.id, tabId, now);
  if (busy) {
    result.action = { do: 'retryLater', afterMs: OTHER_TAB_RETRY_MS, reason: `another tab is signing in to ${site.label}` };
    return false;
  }
  const starts = result.state.starts[site.id] ?? [];
  if (starts.length >= GUARD_MAX_RUNS) {
    pause(result, site, now);
    // Ask again when the pause lifts, so a sign-in page left open carries on by itself.
    result.action = {
      do: 'retryLater',
      afterMs: Math.max(guardResumesAt(starts) - now, 1000),
      reason: `${site.label} is paused after ${GUARD_MAX_RUNS} attempts`,
    };
    return false;
  }
  result.state.starts = { ...result.state.starts, [site.id]: [...starts, now] };
  return true;
}

// A content script reporting the page it's on. Returns the one action it should take.
// sites: the registry (src/sites/registry.js) of the sites to sign in to.
export function decide({ signals, tabId, state, settings, now, sites }) {
  const result = freshResult(state, now);
  let url;
  try {
    url = new URL(signals.url);
  } catch {
    return result;
  }

  const own = tabRun(result.state, tabId, now);
  const act = (action) => {
    result.action = settings.dryRun ? { ...action, dryRun: true } : action;
  };
  const advance = (run, step, where, { waitingForUser = false, ...extra } = {}) => {
    const next = { ...run, ...extra, step, where, lastStepAt: now, waitingForUser };
    setRun(result, next);
    result.effects.push(expiryAlarm(next), { type: 'badge', ...(waitingForUser ? BADGE.WAITING : BADGE.RUNNING) });
    return next;
  };

  const googleStep = classifyGoogle(url, signals.markers ?? {});
  if (googleStep) {
    result.trace = { site: own?.site ?? null, step: googleStep };
    if (!settings.enabled) {
      result.action = noop('switched off');
      return result;
    }
    decideGoogle({ result, step: googleStep, url, signals, own, tabId, settings, now, act, advance, sites });
    return result;
  }

  const site = sites.forUrl(url.href);
  // The site steps this tab's run has already done, so a page showing several picks a new one.
  const done = (own && own.site === site?.id && own.doneSteps) || [];
  const page = site?.classify({ url, found: signals.found ?? {}, settled: Boolean(signals.settled), done });
  if (!page) return result;
  result.page = page;
  result.trace = { site: site.id, step: page.step, where: page.label };

  // Whether I'm signed in is worth knowing even when the extension is switched off.
  if (site.tracksSignIn) {
    const status = page.step === STEP.SIGNED_IN ? 'in' : 'out';
    // Being signed in settles whatever a finished run's badge was saying.
    if (status === 'in' && result.state.signedIn[site.id] !== 'in' && activeRuns(result.state, now).length === 0) {
      result.effects.push({ type: 'badge', ...BADGE.NONE });
    }
    result.state.signedIn = { ...result.state.signedIn, [site.id]: status };
  }
  if (!settings.enabled) {
    result.action = noop('switched off');
    return result;
  }
  if ((settings.disabledSites ?? []).includes(site.id)) {
    result.action = noop(`${site.label} is switched off in options`);
    return result;
  }

  const ownRun = own && own.site === site.id ? own : null;

  if (page.step === STEP.REDIRECT || page.step === STEP.LOGIN) {
    // The current run carries on straight after a redirect step, or at a site step it hasn't
    // done yet (sites whose sign-in takes a few steps). Arriving here at any other point means
    // the last attempt went wrong, so it's a new run.
    const doneSteps = ownRun?.doneSteps ?? [];
    const continuing =
      ownRun !== null &&
      page.step === STEP.LOGIN &&
      (ownRun.step === STEP.REDIRECT || (page.siteStep !== undefined && doneSteps.length > 0 && !doneSteps.includes(page.siteStep)));
    if (!signals.visible) {
      result.action = WAIT_VISIBLE;
      return result;
    }
    if (page.reloadIfOlderThan && signals.pageAgeMs > page.reloadIfOlderThan) {
      act({ do: 'reload', reason: 'the page has been open a while' });
      return result;
    }
    if (page.fillEmail && !settings.email) {
      result.action = noop('no Google account email set in options to fill in');
      return result;
    }

    let run = ownRun;
    if (!continuing) {
      if (!mayStart(result, site, tabId, now)) return result;
      if (own) endRun(result, own, 'restarted', `Came back to ${page.label} from ${describeStep(own)}`, now);
      run = newRun({ tabId, now, site: site.id });
    }
    advance(run, page.step, page.label, page.siteStep === undefined ? {} : { doneSteps: [...(run.doneSteps ?? []), page.siteStep] });
    if (page.step === STEP.REDIRECT) act({ do: 'navigate', url: page.url });
    else if (page.fillEmail) act({ do: 'fillEmail', field: page.fillEmail, element: page.click, email: settings.email });
    else act({ do: 'click', element: page.click });
    return result;
  }

  if (page.step === STEP.HANDOVER) {
    act({ do: 'focus', element: page.focus });
    if (ownRun) {
      endRun(result, { ...ownRun, step: page.step, where: page.label }, 'handedOver', `Handed over at ${page.label}`, now);
      succeeded(result, site.id);
      result.effects.push({
        type: 'badge',
        text: page.badge ?? BADGE.HANDOVER.text,
        color: BADGE.HANDOVER.color,
        clearAfterMs: BADGE_CLEAR_MS,
      });
      if (!signals.visible) {
        result.effects.push({ type: 'notify', message: `${site.label} is waiting for ${page.waitingFor ?? 'you'}.` });
      }
    }
    return result;
  }

  if (page.step === STEP.SIGNED_IN && ownRun) {
    endRun(result, { ...ownRun, step: page.step, where: page.label }, 'signedIn', `Signed in to ${site.label}`, now);
    succeeded(result, site.id);
    result.effects.push({ type: 'badge', ...BADGE.NONE });
  }
  return result;
}

function decideGoogle({ result, step, url, signals, own, tabId, settings, now, act, advance, sites }) {
  // Google's pages continue the run in their tab. With no run there, only a sign-in to
  // Google itself can start one: the Google loop.
  const run = own ?? startGoogleLoop({ result, step, url, signals, tabId, settings, now, sites });
  if (!run) return;
  result.trace.site = run.site;
  const site = sites.byId(run.site);
  if (!site) return;
  // Only act on a Google sign-in that's for this run's site. Once one page has shown
  // that, the rest of the run trusts it.
  if (!run.siteConfirmed && !googleFlowIsFor(site, url.href, signals.markers?.continueTo)) {
    result.action = noop(`this Google sign-in isn't for ${site.label}`);
    return;
  }
  // Continue/Allow belong to another app's sign-in, never to the Google loop.
  if (site.googleItself && step === STEP.GOOGLE_CONSENT) {
    result.action = noop("the Google loop doesn't click Continue or Allow for other apps");
    return;
  }

  const waitingForUser = WAITING_STEPS.has(step);
  advance(run, step, null, { waitingForUser, siteConfirmed: true });

  if (waitingForUser) {
    const isPassword = step === STEP.GOOGLE_PASSWORD;
    act(
      isPassword
        ? { do: 'awaitPassword', submitWhenFilled: settings.submitAutofilledPassword }
        : { do: 'awaitCode', assist: settings.googleTwoStepAssist !== false },
    );
    if (!signals.visible) {
      result.effects.push({
        type: 'notify',
        message: `Google wants your ${isPassword ? 'password' : 'verification code'} to finish signing in to ${site.label}.`,
      });
    }
    return;
  }

  if (step === STEP.GOOGLE_CONSENT) {
    act({ do: 'click', element: 'googleConsent' });
    return;
  }

  if (!settings.email) {
    endRun(result, result.state.runs[tabId], 'error', 'No Google account email set in options', now);
    result.effects.push(
      { type: 'notify', message: "Set your Google account email in the extension's options. Pick the account by hand this time." },
      { type: 'badge', ...BADGE.PROBLEM },
    );
    return;
  }
  const actions = {
    [STEP.GOOGLE_CHOOSER]: 'clickAccount',
    [STEP.GOOGLE_VERIFY]: 'confirmAccount',
    [STEP.GOOGLE_IDENTIFIER]: 'enterEmail',
  };
  act({ do: actions[step], email: settings.email });
}

// Starts a Google loop run for a Google sign-in page with no run in its tab, if the page is a
// sign-in to Google itself. Returns the new run, or null (with result.action set to say why).
function startGoogleLoop({ result, step, url, signals, tabId, settings, now, sites }) {
  const site = sites.googleLoop;
  if (!site) return null;
  if (step === STEP.GOOGLE_CONSENT || !isGoogleOwnSignIn(url)) {
    result.action = noop("not a sign-in to Google itself, and no run started it");
    return null;
  }
  if ((settings.disabledSites ?? []).includes(site.id)) {
    result.action = noop(`${site.label} is switched off in options`);
    return null;
  }
  if (!signals.visible) {
    result.action = WAIT_VISIBLE;
    return null;
  }
  if (!mayStart(result, site, tabId, now)) return null;
  return { ...newRun({ tabId, now, site: site.id }), siteConfirmed: true };
}

// The Google loop's tab left a Google sign-in page. Once I'm signed in, Google sends the tab
// on to wherever it was going, where the content script can't follow. So background.js waits
// a moment (GOOGLE_LEAVE_GRACE_MS), and finishGoogleLoop() settles it, unless another Google
// page has turned up in the meantime.
export function googleLeft({ state, tabId, now, sites }) {
  const result = { ...freshResult(state, now), leftAt: null };
  const run = tabRun(result.state, tabId, now);
  if (!run || !sites.byId(run.site)?.googleItself) return result;
  setRun(result, { ...run, leftAt: now });
  result.leftAt = now;
  return result;
}

// where: what the tab is showing now. 'elsewhere' means Google sent it on (signed in);
// 'googleAccount' means it landed on Google's own account page (also signed in); 'google' means
// it's still on a Google sign-in page the content script doesn't cover; 'gone' means the tab
// was closed. The Google site's redirect rule normally sends a fresh sign-in straight past the
// account page to settings.googleLandingUrl; landing there anyway, the tab goes on from here.
export function finishGoogleLoop({ state, tabId, leftAt, now, where, settings }) {
  const result = freshResult(state, now);
  const run = tabRun(result.state, tabId, now);
  if (!run || run.leftAt !== leftAt || run.lastStepAt > leftAt) return result;
  if (where === 'google') return result;
  if (where === 'gone') {
    endRun(result, run, 'stalled', 'The tab was closed', now);
  } else {
    endRun(result, run, 'signedIn', 'Signed in to Google', now);
    succeeded(result, run.site);
    if (where === 'googleAccount' && settings?.goToGoogleLanding && settings.googleLandingUrl) {
      result.effects.push({ type: 'navigate', tabId, url: settings.googleLandingUrl });
    }
  }
  result.effects.push({ type: 'badge', ...BADGE.NONE });
  return result;
}

// A run's expiry alarm fired: if it hasn't moved on since, it's stuck.
export function expireRun({ state, tabId, now, sites }) {
  const result = freshResult(state, now);
  const run = state.runs?.[tabId];
  if (!run || run.ended || runActive(run, now)) return result;

  if (QUIET_STEPS.has(run.step)) {
    endRun(result, run, 'stalled', 'No sign-in page appeared (probably already signed in)', now);
    result.effects.push({ type: 'badge', ...BADGE.NONE });
    return result;
  }

  const where = `${describeStep(run)}${run.waitingForUser ? ' while waiting for you' : ''}`;
  endRun(result, run, 'stalled', `Stopped at ${where}`, now);
  result.effects.push(
    { type: 'notify', message: `Signing in to ${sites.label(run.site)} stopped at ${where}. Finish signing in by hand.` },
    { type: 'badge', ...BADGE.PROBLEM },
  );
  return result;
}

// The content script couldn't carry out its action (usually a selector that no longer matches).
export function contentError({ state, tabId, message, now, sites }) {
  const result = freshResult(state, now);
  const run = tabRun(result.state, tabId, now);
  if (!run) return result;

  endRun(result, run, 'error', `${describeStep(run)}: ${message}`, now);
  result.effects.push(
    {
      type: 'notify',
      message: `Signing in to ${sites.label(run.site)} failed at ${describeStep(run)}: ${message}. Finish signing in by hand.`,
    },
    { type: 'badge', ...BADGE.PROBLEM },
  );
  return result;
}

// The tab was closed: its run (if any) ends quietly.
export function tabClosed({ state, tabId, now }) {
  const result = freshResult(state, now);
  const run = tabRun(result.state, tabId, now);
  if (run) endRun(result, run, 'stalled', 'The tab was closed', now);
  const { [tabId]: _closed, ...runs } = result.state.runs;
  result.state.runs = runs;
  if (run && activeRuns(result.state, now).length === 0) result.effects.push({ type: 'badge', ...BADGE.NONE });
  return result;
}
