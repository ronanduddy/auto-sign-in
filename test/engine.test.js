import { test, equal, ok } from './harness.js';
import {
  STEP,
  BADGE,
  decide,
  expireRun,
  contentError,
  emptyState,
  runActive,
  pausedSites,
  isGoogleOwnSignIn,
  tabClosed,
  googleLeft,
  finishGoogleLoop,
  runBanner,
  BANNER_MS,
} from '../src/lib/engine.js';
import { DEFAULT_SETTINGS, RUN_WINDOW_MS, GUARD_MAX_RUNS, GUARD_WINDOW_MS, OTHER_TAB_RETRY_MS } from '../src/lib/config.js';
import { STALE_MS } from '../src/sites/types/slack.js';
import { sites, flowSites } from './fixture.js';

const TEAM_URL = sites.byId('slack').workspace.url;

// URLs as mapped on 2026-10-16 (Google's query strings are made up; only their shape matters).
const SIGNOUT_URL =
  'https://app.slack.com/workspace-signin?redir=%2Fgantry%2Fauth%3Fapp%3Dclient%26lc%3D1792095986%26return_to%3D%252Fclient%252FT0123ABCD%252FC0456EFGH%26teams%3DT0123ABCD';
const BARE_PICKER = 'https://app.slack.com/workspace-signin';
const OTHER_TEAM_PICKER = SIGNOUT_URL.replace('teams%3DT0123ABCD', 'teams%3DTOTHER');
const TEAM = 'https://example.slack.com/';
const CLIENT = 'https://app.slack.com/client/T0123ABCD/C0123ABCD';
const chooserFor = (redirect) =>
  `https://accounts.google.com/v3/signin/accountchooser?client_id=123&redirect_uri=${encodeURIComponent(redirect)}`;
const SLACK_CHOOSER = chooserFor('https://slack.com/api/oauth');
const PASSWORD = 'https://accounts.google.com/v3/signin/challenge/pwd?TL=abc';
const CONSENT = 'https://accounts.google.com/signin/oauth/id?authuser=0&part=xyz';
const ALLOW = 'https://accounts.google.com/signin/oauth/v2/consentsummary?part=xyz';
const DASHBOARD = 'https://dashboard.example.test';
const DEPLOYS = 'https://deploys.staging.example.test';

const EMAIL = 'me@example.org';
const SETTINGS = { ...DEFAULT_SETTINGS, email: EMAIL };
const TAB = 7;
const T0 = 1_800_000_000_000;

const SIGNIN = { found: { googleButton: true } }; // Slack's and Error tracker's sign-in pages
const MFA = { found: { mfaInput: true } };
const LOGIN = { found: { signIn: true } }; // any "button" site's sign-in page (Dashboard, Deploys, Error tracker, Internal app…)
const HANDOVER_1 = { found: { handover1: true } }; // a "button" site's first verification page
const SETTLED = { settled: true };

function step(
  state,
  url,
  { found = {}, markers = {}, ...signals } = {},
  { now = T0, tabId = TAB, settings = SETTINGS, registry = sites } = {},
) {
  return decide({
    signals: { url, visible: true, pageAgeMs: 500, settled: false, found, markers, ...signals },
    tabId,
    state,
    settings,
    now,
    sites: registry,
  });
}

const run = (result) => result.state.runs[TAB];
const hasEffect = (result, type, match = {}) =>
  result.effects.some((e) => e.type === type && Object.entries(match).every(([k, v]) => e[k] === v));
const logged = (result) => result.effects.find((e) => e.type === 'log')?.entry;

test("walks Slack's whole flow and hands over at its MFA page", () => {
  let now = T0;
  let r = step(emptyState(), SIGNOUT_URL, {}, { now });
  equal(r.action, { do: 'navigate', url: TEAM_URL }, 'picker action');
  equal(r.state.starts, { slack: [now] }, 'run counted for Slack');

  r = step(r.state, TEAM, SIGNIN, { now: (now += 1000) });
  equal(r.action, { do: 'click', element: 'googleButton' }, 'sign-in action');
  equal(r.state.starts.slack.length, 1, 'same run, not a new one');

  r = step(r.state, SLACK_CHOOSER, {}, { now: (now += 1000) });
  equal(r.action, { do: 'clickAccount', email: EMAIL }, 'chooser action');
  ok(run(r).siteConfirmed, 'confirmed from the URL');

  r = step(r.state, PASSWORD, {}, { now: (now += 1000) });
  equal(r.action, { do: 'awaitPassword', submitWhenFilled: true }, 'password action');
  ok(run(r).waitingForUser, 'waiting for me');
  ok(hasEffect(r, 'badge', { text: BADGE.WAITING.text }), 'PW badge');
  ok(!hasEffect(r, 'notify'), 'no notification while I am looking');
  ok(runActive(run(r), now + RUN_WINDOW_MS + 1000), 'window stretched while waiting');

  r = step(r.state, CONSENT, {}, { now: (now += 5 * 60_000) });
  equal(r.action, { do: 'click', element: 'googleConsent' }, 'consent action');
  ok(!run(r).waitingForUser, 'no longer waiting');

  r = step(r.state, TEAM, MFA, { now: (now += 1000) });
  equal(r.action, { do: 'focus', element: 'mfaInput' }, 'mfa action');
  equal(run(r).outcome, 'handedOver', 'run ended at MFA');
  equal(logged(r).site, 'slack');
  ok(hasEffect(r, 'badge', { text: 'MFA' }), 'MFA badge');
  equal(r.state.starts, {}, 'loop guard count cleared');
});

test('signs in to Dashboard: its button, the account, Continue, Allow, then its own pages', () => {
  let r = step(emptyState(), `${DASHBOARD}/login`, LOGIN);
  equal(r.action, { do: 'click', element: 'signIn' });
  equal(run(r).site, 'dashboard');

  r = step(r.state, chooserFor(`${DASHBOARD}/login/google`), {}, { now: T0 + 1000 });
  equal(r.action, { do: 'clickAccount', email: EMAIL }, 'chooser');
  r = step(r.state, CONSENT, {}, { now: T0 + 2000 });
  equal(r.action, { do: 'click', element: 'googleConsent' }, 'Continue');
  r = step(r.state, ALLOW, {}, { now: T0 + 3000 });
  equal(r.action, { do: 'click', element: 'googleConsent' }, 'Allow');

  r = step(r.state, `${DASHBOARD}/d/abc/overview`, {}, { now: T0 + 4000 });
  equal(run(r).ended, false, 'not before the page settles');
  r = step(r.state, `${DASHBOARD}/d/abc/overview`, SETTLED, { now: T0 + 7000 });
  equal(run(r).outcome, 'signedIn');
  equal(logged(r).detail, 'Signed in to Dashboard');
  equal(r.state.starts, {}, 'loop guard count cleared');
});

test("signs in to Deploys the same way, as a separate site", () => {
  let r = step(emptyState(), `${DEPLOYS}/login?return_url=%2Fapplications`, LOGIN);
  equal(r.action, { do: 'click', element: 'signIn' });
  equal(r.state.starts, { 'deploys-staging': [T0] });
  r = step(r.state, chooserFor(`${DEPLOYS}/api/dex/callback`), {}, { now: T0 + 1000 });
  equal(r.action.do, 'clickAccount');
  r = step(r.state, `${DEPLOYS}/applications`, SETTLED, { now: T0 + 5000 });
  equal(run(r).outcome, 'signedIn');
});

test("hands over at Error tracker's 2FA page", () => {
  let r = step(emptyState(), 'https://errors.example.test/auth/login/', LOGIN);
  equal(r.action, { do: 'click', element: 'signIn' });
  r = step(r.state, chooserFor('https://errors.example.test/identity/login/google/'), {}, { now: T0 + 1000 });
  equal(r.action.do, 'clickAccount');
  r = step(r.state, 'https://errors.example.test/auth/2fa/', HANDOVER_1, { now: T0 + 2000 });
  equal(r.action, { do: 'focus', element: 'handover1' });
  equal(run(r).outcome, 'handedOver');
});

test("signs in to Internal app through Google's SAML sign-in and hands over at its two-factor page", () => {
  const INTERNAL = 'https://internal.example.test';
  const SAML_CHOOSER =
    'https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Faccounts.google.com%2Fo%2Fsaml2%2Fcontinue%3Fidpid%3Dabc';
  let r = step(emptyState(), `${INTERNAL}/portal`, LOGIN);
  equal(r.action, { do: 'click', element: 'signIn' });
  r = step(r.state, SAML_CHOOSER, {}, { now: T0 + 1000 });
  equal(r.action, { do: 'clickAccount', email: EMAIL }, "Google's SAML endpoint in the URL is enough");
  r = step(r.state, `${INTERNAL}/portal/mfa/method/new`, { found: { handover2: true } }, { now: T0 + 2000 });
  equal(r.action, { do: 'focus', element: 'handover2' });
  equal(run(r).outcome, 'handedOver');

  const other = step(emptyState(), `${INTERNAL}/portal`, LOGIN);
  const plainChooser = 'https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Fexample.com';
  equal(step(other.state, plainChooser, { markers: { continueTo: 'Internal app' } }).action.do, 'clickAccount', 'or the app name');
  equal(step(other.state, plainChooser).action.do, 'noop', 'neither: left alone');
});

test("checks the Feature flags site's Google sign-in against its domain, with or without www", () => {
  let r = step(emptyState(), 'https://www.flags.example.test/signin', LOGIN);
  equal(r.action, { do: 'click', element: 'signIn' });
  r = step(r.state, chooserFor('https://flags.example.test/auth/google_oauth2/callback'), {}, { now: T0 + 1000 });
  equal(r.action.do, 'clickAccount');
});

const GMAIL_CHOOSER = 'https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail';

test('tells a sign-in to Google itself from "Sign in with Google" for another app', () => {
  ok(isGoogleOwnSignIn(new URL('https://accounts.google.com/v3/signin/accountchooser')), 'bare chooser');
  ok(isGoogleOwnSignIn(new URL(GMAIL_CHOOSER)), 'continuing to Gmail');
  ok(!isGoogleOwnSignIn(new URL(SLACK_CHOOSER)), 'an OAuth redirect address');
  ok(!isGoogleOwnSignIn(new URL(`${GMAIL_CHOOSER.split('?')[0]}?continue=https%3A%2F%2Fevil.example%2F`)), 'continuing elsewhere');
  ok(
    !isGoogleOwnSignIn(new URL('https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Faccounts.google.com%2Fo%2Fsaml2%2Fcontinue')),
    'SAML',
  );
});

test("the Google loop signs in to Google itself, and is done once Google sends the tab on", () => {
  let r = step(emptyState(), GMAIL_CHOOSER);
  equal(r.action, { do: 'clickAccount', email: EMAIL }, 'starts on its own');
  equal(run(r).site, 'google');
  equal(r.state.starts, { google: [T0] });
  r = step(r.state, PASSWORD, {}, { now: T0 + 1000 });
  equal(r.action, { do: 'awaitPassword', submitWhenFilled: true });

  const left = googleLeft({ state: r.state, tabId: TAB, now: T0 + 2000, sites });
  equal(left.leftAt, T0 + 2000);
  equal(finishGoogleLoop({ state: left.state, tabId: TAB, leftAt: T0 + 2000, now: T0 + 10_000, where: 'google' }).effects, [], 'still on Google');
  const done = finishGoogleLoop({ state: left.state, tabId: TAB, leftAt: T0 + 2000, now: T0 + 10_000, where: 'elsewhere' });
  equal(run(done).outcome, 'signedIn');
  equal(logged(done).detail, 'Signed in to Google');
  equal(done.state.starts, {}, 'loop guard count cleared');
});

test("after signing in to Google, goes on to Gmail if the tab is still on Google's account page", () => {
  const finish = (where, settings = SETTINGS) => {
    const started = step(emptyState(), GMAIL_CHOOSER, {}, { settings });
    const left = googleLeft({ state: started.state, tabId: TAB, now: T0 + 1000, sites });
    return finishGoogleLoop({ state: left.state, tabId: TAB, leftAt: T0 + 1000, now: T0 + 9000, where, settings });
  };
  const navigate = (r) => r.effects.find((e) => e.type === 'navigate');
  equal(navigate(finish('googleAccount')), { type: 'navigate', tabId: TAB, url: 'https://mail.google.com/mail/' }, 'on My Account');
  equal(run(finish('googleAccount')).outcome, 'signedIn');
  equal(navigate(finish('elsewhere')), undefined, 'already somewhere else (Gmail, Drive…): left alone');
  equal(navigate(finish('googleAccount', { ...SETTINGS, goToGoogleLanding: false })), undefined, 'option off');
});

test('the Google loop carries on if another Google page follows, and ends quietly if the tab closes', () => {
  let r = step(emptyState(), GMAIL_CHOOSER);
  const left = googleLeft({ state: r.state, tabId: TAB, now: T0 + 1000, sites });
  r = step(left.state, PASSWORD, {}, { now: T0 + 3000 });
  equal(finishGoogleLoop({ state: r.state, tabId: TAB, leftAt: T0 + 1000, now: T0 + 9000, where: 'elsewhere' }).effects, [], 'a newer page');
  const closed = finishGoogleLoop({ state: left.state, tabId: TAB, leftAt: T0 + 1000, now: T0 + 9000, where: 'gone' });
  equal(run(closed).outcome, 'stalled');
  ok(!hasEffect(closed, 'notify'), 'no warning');
});

test("the Google loop leaves other apps' Google sign-ins and every Continue/Allow alone", () => {
  equal(step(emptyState(), SLACK_CHOOSER).action.do, 'noop', "another app's chooser, no run");
  equal(step(emptyState(), CONSENT).action.do, 'noop', 'consent, no run');
  const started = step(emptyState(), GMAIL_CHOOSER).state;
  equal(step(started, CONSENT, {}, { now: T0 + 1000 }).action.do, 'noop', 'consent during a Google run');
  equal(googleLeft({ state: step(emptyState(), TEAM, SIGNIN).state, tabId: TAB, now: T0 + 1, sites }).leftAt, null, 'other sites are not finished by leaving Google');
});

test('the Google loop waits for the tab, for other tabs, and can be switched off', () => {
  equal(step(emptyState(), GMAIL_CHOOSER, { visible: false }).action.do, 'waitVisible');
  const slackRun = step(emptyState(), TEAM, SIGNIN).state;
  equal(step(slackRun, GMAIL_CHOOSER, {}, { tabId: 99 }).action.do, 'clickAccount', "another site's run doesn't hold it up");
  const googleRun = step(emptyState(), GMAIL_CHOOSER).state;
  equal(step(googleRun, GMAIL_CHOOSER, {}, { tabId: 99 }).action.do, 'retryLater', 'another Google run does');
  equal(step(emptyState(), GMAIL_CHOOSER, {}, { settings: { ...SETTINGS, disabledSites: ['google'] } }).action.do, 'noop');
});

test("recognises Google's email page by its address", () => {
  let r = step(emptyState(), `${DASHBOARD}/login`, LOGIN);
  r = step(r.state, `https://accounts.google.com/v3/signin/identifier?redirect_uri=${encodeURIComponent(`${DASHBOARD}/login/google`)}`, {}, { now: T0 + 1000 });
  equal(r.action, { do: 'enterEmail', email: EMAIL });
});

test("hands Google's 2-Step page to me, with the remember-device and Next help unless it's off", () => {
  const TOTP = 'https://accounts.google.com/v3/signin/challenge/totp?TL=abc';
  let r = step(emptyState(), TEAM, SIGNIN);
  r = step(r.state, SLACK_CHOOSER, {}, { now: T0 + 1000 });
  const twoStep = step(r.state, TOTP, {}, { now: T0 + 2000 });
  equal(twoStep.action, { do: 'awaitCode', assist: true });
  ok(run(twoStep).waitingForUser, 'waits for me (10-minute window)');
  equal(step(r.state, TOTP, {}, { now: T0 + 2000, settings: { ...SETTINGS, googleTwoStepAssist: false } }).action, { do: 'awaitCode', assist: false });
});

test("clicks Continue/Allow for the run's own site, whatever app Google names", () => {
  let r = step(emptyState(), `${DASHBOARD}/login`, LOGIN);
  r = step(r.state, chooserFor(`${DASHBOARD}/login/google`), {}, { now: T0 + 1000 });
  equal(step(r.state, CONSENT, { markers: { consentApp: 'Some App' } }, { now: T0 + 2000 }).action, { do: 'click', element: 'googleConsent' });
});

test('skips the password step when Google is still signed in', () => {
  let r = step(emptyState(), TEAM, SIGNIN);
  r = step(r.state, SLACK_CHOOSER, {}, { now: T0 + 1000 });
  r = step(r.state, CONSENT, {}, { now: T0 + 2000 });
  r = step(r.state, TEAM, MFA, { now: T0 + 3000 });
  equal(run(r).outcome, 'handedOver');
});

test('waits until the tab is visible before starting', () => {
  const r = step(emptyState(), SIGNOUT_URL, { visible: false });
  equal(r.action.do, 'waitVisible');
  equal(r.state.runs, {}, 'no run yet');
  equal(r.state.starts, {}, 'nothing counted');
});

test('starts from the bare workspace sign-in page too, but not one for another workspace', () => {
  equal(step(emptyState(), BARE_PICKER).action, { do: 'navigate', url: TEAM_URL }, 'bare picker');
  const other = step(emptyState(), OTHER_TEAM_PICKER);
  equal(other.action.do, 'noop', 'other workspace');
  equal(other.state.runs, {});
});

test("reloads a stale Slack sign-in page before clicking, without starting a run", () => {
  const r = step(emptyState(), TEAM, { ...SIGNIN, pageAgeMs: STALE_MS + 1 });
  equal(r.action.do, 'reload');
  equal(r.state.runs, {});
  const dashboard = step(emptyState(), `${DASHBOARD}/login`, { ...LOGIN, pageAgeMs: STALE_MS + 1 });
  equal(dashboard.action.do, 'click', 'sites without a stale token just click');
});

test('ignores Google pages when no run is active', () => {
  equal(step(emptyState(), SLACK_CHOOSER).action.do, 'noop', 'no run at all');
  const started = step(emptyState(), TEAM, SIGNIN).state;
  equal(step(started, SLACK_CHOOSER, {}, { now: T0 + RUN_WINDOW_MS + 1 }).action.do, 'noop', 'run expired');
});

test("ignores Google sign-ins that aren't for the run's site", () => {
  const started = step(emptyState(), `${DASHBOARD}/login`, LOGIN).state;
  equal(step(started, SLACK_CHOOSER).action.do, 'noop', "Slack's sign-in during a Dashboard run");
  const gmail = 'https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Fmail.google.com';
  equal(step(started, gmail, { markers: { continueTo: 'Gmail' } }).action.do, 'noop', 'Gmail');
  equal(step(started, gmail, { markers: { continueTo: 'Dashboard' } }).action.do, 'clickAccount', 'page says Dashboard');
});

test('sign-ins to different sites go ahead side by side; a second tab for the same site waits', () => {
  const started = step(emptyState(), TEAM, SIGNIN).state;
  const dashboard = step(started, `${DASHBOARD}/login`, LOGIN, { tabId: 99 });
  equal(dashboard.action, { do: 'click', element: 'signIn' }, 'Dashboard in another tab goes ahead');
  equal(Object.keys(dashboard.state.runs).sort(), [String(99), String(TAB)].sort(), 'both runs live');
  const slackAgain = step(started, SIGNOUT_URL, {}, { tabId: 99 });
  equal([slackAgain.action.do, slackAgain.action.afterMs], ['retryLater', OTHER_TAB_RETRY_MS], 'Slack in another tab waits');
  equal(slackAgain.action.reason, 'another tab is signing in to Slack');
  equal(step(started, SLACK_CHOOSER, {}, { tabId: 99 }).action.do, 'noop', "Google pages in a tab with no run of its own");
});

test('a closed tab ends its run quietly and frees its site', () => {
  const started = step(emptyState(), TEAM, SIGNIN).state;
  const closed = tabClosed({ state: started, tabId: TAB, now: T0 + 1000 });
  equal(closed.state.runs, {});
  equal(logged(closed).detail, 'The tab was closed');
  ok(!hasEffect(closed, 'notify'));
  equal(step(closed.state, SIGNOUT_URL, {}, { tabId: 99, now: T0 + 2000 }).action.do, 'navigate', 'Slack can start in another tab');
});

test('the loop guard counts each site separately, says so once, then recovers', () => {
  let state = emptyState();
  for (let i = 0; i < GUARD_MAX_RUNS; i += 1) {
    const r = step(state, TEAM, SIGNIN, { now: T0 + i * 60_000 });
    equal(r.action.do, 'click', `run ${i + 1}`);
    state = r.state;
  }
  const pausedAt = T0 + GUARD_MAX_RUNS * 60_000;
  let r = step(state, TEAM, SIGNIN, { now: pausedAt });
  equal([r.action.do, r.action.afterMs], ['retryLater', T0 + GUARD_WINDOW_MS - pausedAt], 'paused, ask again when it lifts');
  equal(r.action.reason, 'Slack is paused after 3 attempts');
  ok(hasEffect(r, 'notify'), 'told me');
  equal(r.effects.find((e) => e.type === 'badge').clearAfterMs, T0 + GUARD_WINDOW_MS - pausedAt, 'warning clears on resume');
  equal(pausedSites(r.state.starts, pausedAt), [{ site: 'slack', resumesAt: T0 + GUARD_WINDOW_MS }]);

  equal(step(r.state, `${DASHBOARD}/login`, LOGIN, { now: pausedAt }).action.do, 'click', 'Dashboard is unaffected');

  r = step(r.state, TEAM, SIGNIN, { now: pausedAt + 60_000 });
  ok(!hasEffect(r, 'notify'), 'told me only once');
  r = step(r.state, TEAM, SIGNIN, { now: T0 + GUARD_WINDOW_MS + 1 });
  equal(r.action.do, 'click', 'allowed again once the oldest run ages out');
});

test('logs a restart when the flow comes back to the sign-in page mid-run', () => {
  let r = step(emptyState(), TEAM, SIGNIN);
  r = step(r.state, SLACK_CHOOSER, {}, { now: T0 + 1000 });
  r = step(r.state, TEAM, SIGNIN, { now: T0 + 2000 });
  equal(r.action.do, 'click');
  equal(logged(r).outcome, 'restarted');
  equal(logged(r).detail, "Came back to Slack's sign-in page from Google's account chooser");
  equal(r.state.starts.slack.length, 2, 'counts towards the loop guard');
});

test('does nothing when switched off, or for a site switched off in options', () => {
  equal(step(emptyState(), SIGNOUT_URL, {}, { settings: { ...SETTINGS, enabled: false } }).action.do, 'noop');
  const noDashboard = { ...SETTINGS, disabledSites: ['dashboard'] };
  equal(step(emptyState(), `${DASHBOARD}/login`, LOGIN, { settings: noDashboard }).action.do, 'noop', 'Dashboard off');
  equal(step(emptyState(), TEAM, SIGNIN, { settings: noDashboard }).action.do, 'click', 'Slack still on');
});

test('marks every action as a dry run in dry-run mode', () => {
  const r = step(emptyState(), TEAM, SIGNIN, { settings: { ...SETTINGS, dryRun: true } });
  equal(r.action, { do: 'click', element: 'googleButton', dryRun: true });
});

test('stops at the account chooser if no email is set', () => {
  const settings = { ...SETTINGS, email: '' };
  let r = step(emptyState(), TEAM, SIGNIN, { settings });
  r = step(r.state, SLACK_CHOOSER, {}, { now: T0 + 1000, settings });
  equal(r.action.do, 'noop');
  equal(run(r).outcome, 'error');
  ok(hasEffect(r, 'notify'));
});

test('leaves submitting the password to me when that option is off', () => {
  const settings = { ...SETTINGS, submitAutofilledPassword: false };
  let r = step(emptyState(), TEAM, SIGNIN, { settings });
  r = step(r.state, SLACK_CHOOSER, {}, { now: T0 + 1000, settings });
  r = step(r.state, PASSWORD, {}, { now: T0 + 2000, settings });
  equal(r.action, { do: 'awaitPassword', submitWhenFilled: false });
});

test('notifies about the password and MFA only when the tab is hidden', () => {
  let r = step(emptyState(), TEAM, SIGNIN);
  r = step(r.state, SLACK_CHOOSER, {}, { now: T0 + 1000 });
  r = step(r.state, PASSWORD, { visible: false }, { now: T0 + 2000 });
  ok(r.effects.some((e) => e.type === 'notify' && e.message.includes('Slack')), 'password, naming the site');
  r = step(r.state, CONSENT, {}, { now: T0 + 3000 });
  r = step(r.state, TEAM, { ...MFA, visible: false }, { now: T0 + 4000 });
  ok(r.effects.some((e) => e.type === 'notify' && e.message === 'Slack is waiting for your MFA code.'), 'mfa');
});

test('focuses the MFA box even without a run', () => {
  const r = step(emptyState(), TEAM, MFA);
  equal(r.action, { do: 'focus', element: 'mfaInput' });
  ok(!hasEffect(r, 'log'));
});

test("tracks whether I'm signed in to Slack, even when switched off", () => {
  const off = { settings: { ...SETTINGS, enabled: false } };
  equal(step(emptyState(), BARE_PICKER, {}, off).state.signedIn, { slack: 'out' }, 'picker');
  equal(step(emptyState(), TEAM, SIGNIN, off).state.signedIn, { slack: 'out' }, 'sign-in options');
  equal(step(emptyState(), TEAM, MFA, off).state.signedIn, { slack: 'out' }, 'MFA');
  equal(step(emptyState(), CLIENT, {}, off).state.signedIn, {}, 'client not settled yet');

  const r = step({ ...emptyState(), signedIn: { slack: 'out' } }, CLIENT, SETTLED);
  equal(r.state.signedIn, { slack: 'in' }, 'client settled');
  ok(hasEffect(r, 'badge', { text: '' }), "clears a finished run's badge");

  const signedIn = { ...emptyState(), signedIn: { slack: 'in' } };
  equal(step(signedIn, OTHER_TEAM_PICKER).state.signedIn, { slack: 'in' }, 'another workspace says nothing');
  equal(step(signedIn, `${DASHBOARD}/login`, LOGIN).state.signedIn, { slack: 'in' }, 'other sites say nothing');
});

test('a stuck run expires with a notification naming the site and step', () => {
  let r = step(emptyState(), `${DASHBOARD}/login`, LOGIN);
  r = step(r.state, chooserFor(DASHBOARD), {}, { now: T0 + 1000 });
  equal(expireRun({ state: r.state, tabId: TAB, now: T0 + 2000, sites }).effects, [], 'not yet');
  const expired = expireRun({ state: r.state, tabId: TAB, now: T0 + 1000 + RUN_WINDOW_MS, sites });
  equal(expired.state.runs[TAB].outcome, 'stalled');
  ok(
    expired.effects.some(
      (e) => e.type === 'notify' && e.message.startsWith("Signing in to Dashboard stopped at Google's account chooser"),
    ),
  );
});

test('a run that never reaches a sign-in page ends quietly', () => {
  const r = step(emptyState(), SIGNOUT_URL);
  const expired = expireRun({ state: r.state, tabId: TAB, now: T0 + RUN_WINDOW_MS, sites });
  equal(expired.state.runs[TAB].outcome, 'stalled');
  ok(!hasEffect(expired, 'notify'), 'no warning');
  ok(hasEffect(expired, 'badge', { text: '' }), 'badge cleared');
});

test('a content-script error ends the run for that tab only', () => {
  const started = step(emptyState(), TEAM, SIGNIN).state;
  equal(contentError({ state: started, tabId: 99, message: 'x', now: T0 + 1, sites }).effects, [], 'other tab');
  const r = contentError({ state: started, tabId: TAB, message: "couldn't find Slack's Google button", now: T0 + 1, sites });
  equal(run(r).outcome, 'error');
  ok(r.effects.some((e) => e.type === 'notify' && e.message.includes("couldn't find")));
});

const ACME = 'https://acme.example.test';
const ACME_ID = 'https://login.acme.example.test';
const acmeStep = (state, url, signals, options = {}) => step(state, url, signals, { registry: flowSites, ...options });

test('a sign-in that takes steps is one run: "Log in", the email, its Google button, Google, then the app', () => {
  let r = acmeStep(emptyState(), `${ACME}/`, { found: { step1: true } });
  equal(r.action, { do: 'click', element: 'step1' });
  equal(run(r).doneSteps, ['step1']);

  r = acmeStep(r.state, `${ACME_ID}/login`, { found: { step2Email: true, step2: true } }, { now: T0 + 1000 });
  equal(r.action, { do: 'fillEmail', field: 'step2Email', element: 'step2', email: EMAIL });
  r = acmeStep(r.state, `${ACME_ID}/login`, { found: { step3: true } }, { now: T0 + 2000 });
  equal(r.action, { do: 'click', element: 'step3' });
  equal(r.state.starts, { acme: [T0] }, 'one run, counted once');
  equal(run(r).where, "Acme's sign-in step 3");

  r = acmeStep(r.state, chooserFor(`${ACME_ID}/oauth/callback`), {}, { now: T0 + 3000 });
  equal(r.action, { do: 'clickAccount', email: EMAIL }, "the sign-in host in Google's address counts");
  r = acmeStep(r.state, `${ACME}/projects`, SETTLED, { now: T0 + 6000 });
  equal(run(r).outcome, 'signedIn');
  equal(r.state.starts, {}, 'loop guard count cleared');
});

test('coming back to a step the run already did is a new attempt', () => {
  let r = acmeStep(emptyState(), `${ACME}/`, { found: { step1: true } });
  r = acmeStep(r.state, `${ACME_ID}/login`, { found: { step2Email: true } }, { now: T0 + 1000 });
  r = acmeStep(r.state, `${ACME}/`, { found: { step1: true } }, { now: T0 + 2000 });
  equal(r.action, { do: 'click', element: 'step1' });
  equal(logged(r).outcome, 'restarted');
  equal(r.state.starts.acme.length, 2, 'counted by the loop guard');
  equal(run(r).doneSteps, ['step1'], 'the new run starts its own list');
});

test("an email step needs the email in the settings, and doesn't start a run without it", () => {
  const r = acmeStep(emptyState(), `${ACME_ID}/login`, { found: { step2Email: true } }, { settings: { ...SETTINGS, email: '' } });
  equal(r.action.do, 'noop');
  equal(r.state.starts, {});
});

test('a dry run outlines an email step instead of typing', () => {
  const r = acmeStep(emptyState(), `${ACME_ID}/login`, { found: { step2Email: true } }, { settings: { ...SETTINGS, dryRun: true } });
  equal(r.action, { do: 'fillEmail', field: 'step2Email', element: 'step2', email: EMAIL, dryRun: true });
});

test('the banner says a sign-in is under way, waiting for me, or how it ended, and none stays for good', () => {
  const shown = (r) => {
    const banner = runBanner(r, sites);
    return [banner.text, banner.hideAfterMs, Boolean(banner.hideOnInput)];
  };
  let r = step(emptyState(), `${DASHBOARD}/login`, LOGIN);
  equal(shown(run(r)), ['Auto sign-in: signing in to Dashboard · sign-in page…', BANNER_MS.step, false], "the site's name once");
  equal(runBanner(run(r), sites, T0 + 500).text, 'Auto sign-in: signing in to Dashboard…', "a page that isn't the step it's on: no step named");
  r = step(r.state, chooserFor(`${DASHBOARD}/login/google`), {}, { now: T0 + 1000 });
  equal(shown(run(r))[0], "Auto sign-in: signing in to Dashboard · Google's account chooser…");
  r = step(r.state, PASSWORD, {}, { now: T0 + 2000 });
  equal(shown(run(r)), ["Auto sign-in: signing in to Dashboard, waiting for you on Google's password page.", BANNER_MS.waiting, true], 'goes when I type');
  r = step(r.state, `${DASHBOARD}/d/abc`, SETTLED, { now: T0 + 9000 });
  equal(shown(run(r)), ['Auto sign-in: signed in to Dashboard.', BANNER_MS.signedIn, false]);
  equal(shown({ site: 'slack', ended: true, outcome: 'handedOver', where: "Slack's MFA page" }), ["Auto sign-in: over to you on Slack's MFA page.", BANNER_MS.handedOver, true]);
  equal(shown({ site: 'slack', ended: true, outcome: 'stalled', step: 'google_chooser' }), [
    "Auto sign-in stopped at Google's account chooser. Finish signing in by hand.",
    BANNER_MS.stopped,
    true,
  ]);
  equal(runBanner(null, sites), null);
  ok(Object.values(BANNER_MS).every((ms) => ms > 0 && ms <= 60_000), 'every banner goes within a minute');
  equal(BANNER_MS.step, 2_000, "a step's banner is brief");
});
