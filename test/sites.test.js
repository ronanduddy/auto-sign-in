// The site types and presets (src/sites/), built from the test config (test/fixture.js): the
// registry, the manifest and each site's classify().
import { test, equal, ok } from './harness.js';
import { matchesPattern } from '../src/sites/index.js';
import { pickerIsForTeam, isLandingUrl } from '../src/sites/types/slack.js';
import { STEP } from '../src/lib/steps.js';
import { DEFAULT_SETTINGS } from '../src/lib/config.js';
import { sites as REGISTRY, flowSites } from './fixture.js';

const SITES = REGISTRY.sites;
const siteForUrl = (url) => REGISTRY.forUrl(url);
const slack = REGISTRY.byId('slack');
const site = (id) => REGISTRY.byId(id);

const SIGNOUT_URL =
  'https://app.slack.com/workspace-signin?redir=%2Fgantry%2Fauth%3Fapp%3Dclient%26lc%3D1792095986%26return_to%3D%252Fclient%252FT0123ABCD%252FC0456EFGH%26teams%3DT0123ABCD';

const classify = (site, href, { found = {}, settled = false, done } = {}) => site.classify({ url: new URL(href), found, settled, done });

test('every site has an id, label, URL patterns, a Google check, elements and classify()', () => {
  const ids = SITES.map((site) => site.id);
  equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const site of SITES) {
    ok(site.id && site.label && site.matches.length, `${site.id}: id, label, matches`);
    ok(new URL(site.home).protocol === 'https:', `${site.id}: home is an https link`);
    ok(Array.isArray(site.labels) && site.labels.every((label) => typeof label === 'string'), `${site.id}: labels are text`);
    for (const pattern of site.reloadOnInstall ?? []) {
      ok(siteForUrl(pattern.replace('*', ''))?.id === site.id, `${site.id}: reloadOnInstall ${pattern} is one of its pages`);
    }
    const { mentions, appNames } = site.google;
    ok(mentions.length && [...mentions, ...appNames].every((text) => typeof text === 'string'), `${site.id}: google`);
    ok(typeof site.classify === 'function', `${site.id}: classify`);
    // Elements go to the content script as a message, so they must be plain data.
    equal(JSON.parse(JSON.stringify(site.elements)), site.elements, `${site.id}: elements are plain data`);
  }
});

test("manifest.json names no site: Google is fixed, every other site's access is granted at runtime", async () => {
  const manifest = await (await fetch('../manifest.json')).json();
  equal(manifest.host_permissions, ['https://accounts.google.com/*', 'https://myaccount.google.com/*']);
  equal(manifest.optional_host_permissions, ['https://*/*']);
  ok(manifest.permissions.includes('scripting'), 'content scripts registered at runtime');
  const googleScript = manifest.content_scripts[0];
  for (const pattern of REGISTRY.googleLoop.matches) ok(googleScript.matches.includes(pattern), pattern);
  for (const site of SITES.filter((s) => !s.googleItself)) {
    const access = REGISTRY.accessFor(site);
    ok(access.length && access.every((origin) => /^https:\/\/[^/*]+\/\*$/.test(origin)), `${site.id}: ${access}`);
  }
});

test('finds the site for a URL', () => {
  const cases = {
    [SIGNOUT_URL]: 'slack',
    'https://app.slack.com/client/T0123ABCD/C0123ABCD': 'slack',
    'https://example.slack.com/': 'slack',
    'https://dashboard.example.test/login': 'dashboard',
    'https://dashboard.staging.example.test/login': 'dashboard-staging',
    'https://deploys.example.test/applications': 'deploys-production',
    'https://deploys.staging.example.test/login?return_url=x': 'deploys-staging',
    'https://errors.example.test/auth/login/': 'errors',
    'https://internal.test/portal': 'internal-local',
    'https://internal.example.test/portal': 'internal',
    'https://internal-training.example.test/portal/mfa/method/new': 'internal-training',
    'https://www.flags.example.test/signin': 'flags',
  };
  for (const [url, id] of Object.entries(cases)) equal(siteForUrl(url)?.id, id, url);
  equal(siteForUrl('https://app.slack.com/client/TOTHER/C1'), null, "another workspace's client");
  equal(siteForUrl('https://accounts.google.com/v3/signin/accountchooser')?.id, 'google', 'the Google loop');
  equal(siteForUrl('https://accounts.google.com/signin/oauth/id'), null, "Google's consent pages belong to other sites' runs");
  equal(siteForUrl('https://example.com/'), null, 'anything else');
  equal(siteForUrl('https://internal.example.test/clients/1'), null, "Internal app's pages outside /portal");
});

test('match patterns treat * as anything and the rest literally', () => {
  ok(matchesPattern('https://app.slack.com/workspace-signin*', 'https://app.slack.com/workspace-signin?redir=x'));
  ok(!matchesPattern('https://errors.example.test/*', 'https://errorsXio/'), 'dots are literal');
  ok(!matchesPattern('https://errors.example.test/*', 'https://evil.example/https://errors.example.test/'), 'anchored at the start');
});

test("Slack's pages", () => {
  equal(classify(slack, SIGNOUT_URL).step, STEP.REDIRECT, 'picker');
  equal(classify(slack, SIGNOUT_URL.replace('teams%3DT0123ABCD', 'teams%3DTOTHER')), null, 'picker for another workspace');
  equal(classify(slack, 'https://example.slack.com/', { found: { googleButton: true } }).step, STEP.LOGIN);
  equal(classify(slack, 'https://example.slack.com/', { found: { mfaInput: true } }).step, STEP.HANDOVER);
  equal(classify(slack, 'https://example.slack.com/'), null, 'neither');
  equal(classify(slack, 'https://app.slack.com/client/T0123ABCD/C1'), null, 'client, not settled');
  equal(classify(slack, 'https://app.slack.com/client/T0123ABCD/C1', { settled: true }).step, STEP.SIGNED_IN);
});

test('a "Sign in with Google" button site: button, signed in, or neither', () => {
  const dashboard = site('dashboard');
  const base = 'https://dashboard.example.test';
  equal(classify(dashboard, `${base}/login`, { found: { signIn: true } }).step, STEP.LOGIN);
  equal(classify(dashboard, `${base}/login`, { settled: true }), null, 'login page without its button yet');
  equal(classify(dashboard, `${base}/d/abc`, { settled: true }).step, STEP.SIGNED_IN);
  equal(classify(dashboard, `${base}/d/abc`), null, 'not settled yet');
});

test("the Slack workspace picker is ours unless it names other workspaces", () => {
  const team = slack.workspace.teamId;
  ok(pickerIsForTeam(SIGNOUT_URL, team), "Slack's sign-out naming the workspace");
  ok(pickerIsForTeam('https://app.slack.com/workspace-signin', team), 'bare page, after signing out by hand');
  ok(pickerIsForTeam('https://app.slack.com/workspace-signin?redir=%2Fclient', team), 'redir without teams');
  ok(!pickerIsForTeam(SIGNOUT_URL.replace('teams%3DT0123ABCD', 'teams%3DTOTHER'), team), 'another workspace');
});

test("Slack's two settings: skip the desktop-app prompt, and open a page instead of the default view", () => {
  const channel = 'https://app.slack.com/client/T0123ABCD/C0123ABCD';
  const both = slack.rules({ ...DEFAULT_SETTINGS, landingUrl: channel });
  equal(both.map((rule) => [rule.id, rule.action.redirect.url]), [[1, channel], [3, channel]]);
  equal(both[0].condition, { urlFilter: '|https://example.slack.com/ssb/redirect', resourceTypes: ['main_frame'] });
  const defaultView = new RegExp(both[1].condition.regexFilter);
  ok(defaultView.test('https://app.slack.com/client/T0123ABCD') && defaultView.test('https://app.slack.com/client/T0123ABCD/?x=1'), "the workspace's default view");
  ok(!defaultView.test(channel) && !defaultView.test('https://app.slack.com/client/TOTHER'), 'not a channel, nor another workspace');

  const skipOnly = (settings) => slack.rules({ ...DEFAULT_SETTINGS, ...settings }).map((rule) => [rule.id, rule.action.redirect.url]);
  equal(skipOnly({}), [[1, 'https://app.slack.com/client/T0123ABCD']], 'no page: the prompt goes to the default view');
  equal(skipOnly({ goToSlackLanding: false, landingUrl: channel }), [[1, 'https://app.slack.com/client/T0123ABCD']], 'landing switched off');
  equal(skipOnly({ skipDesktopPrompt: false, landingUrl: channel }), [[3, channel]], 'landing on its own');
  equal(skipOnly({ skipDesktopPrompt: false, landingUrl: 'https://example.com/' }), [], 'not a Slack page');
  equal(skipOnly({ skipDesktopPrompt: false, landingUrl: 'https://app.slack.com/client/T0123ABCD/' }), [], 'the default view itself would loop');
  ok(!isLandingUrl('https://example.slack.com/ssb/redirect'), 'the launcher itself is not a landing page');
});

test("Internal app's team pages: Sign in, two-factor (either page), or signed in", () => {
  const internal = site('internal');
  const base = 'https://internal.example.test';
  const login = classify(internal, `${base}/portal`, { found: { signIn: true } });
  equal(login.step, STEP.LOGIN);
  equal(login.reloadIfOlderThan, 5 * 60_000, 'reloads a stale sign-in form first');
  equal(classify(internal, `${base}/portal/mfa/method/new`, { found: { handover2: true } }).focus, 'handover2');
  equal(classify(internal, `${base}/portal/mfa/verify/new`, { found: { handover1: true } }).focus, 'handover1');
  equal(classify(internal, `${base}/portal`, { settled: true }), null, 'the sign-in page is never "signed in"');
  equal(classify(internal, `${base}/portal/auth/saml/callback`, { settled: true }), null, 'nor the SAML callback');
  equal(classify(internal, `${base}/portal/reports/1`, { settled: true }).step, STEP.SIGNED_IN);
});

test('a button site can keep its sign-in page somewhere other than /login (Feature flags)', () => {
  const flags = site('flags');
  equal(flags.elements.signIn.path, '/signin');
  equal(classify(flags, 'https://www.flags.example.test/signin', { found: { signIn: true } }).step, STEP.LOGIN);
  equal(classify(flags, 'https://www.flags.example.test/signin', { settled: true }), null, 'its sign-in page is never "signed in"');
  equal(classify(flags, 'https://www.flags.example.test/projects', { settled: true }).step, STEP.SIGNED_IN);
});

test('"Sign out of all" covers every site\'s origin, once each', () => {
  const origins = REGISTRY.origins();
  equal(new Set(origins).size, origins.length, 'no duplicates');
  for (const origin of ['https://accounts.google.com', 'https://app.slack.com', 'https://example.slack.com',
    'https://dashboard.staging.example.test', 'https://deploys.example.test', 'https://errors.example.test',
    'https://internal.test', 'https://www.flags.example.test']) {
    ok(origins.includes(origin), origin);
  }
  ok(origins.every((origin) => origin.startsWith('https://') && !origin.includes('*')), 'plain https origins');
});

test('lists the sites alphabetically for people to read', () => {
  const labels = REGISTRY.byLabel().map((site) => site.label);
  equal(labels, [...labels].sort((a, b) => a.localeCompare(b)));
  equal(labels.length, SITES.length);
  equal(labels[0], 'Dashboard');
});

test("Google's rule sends a fresh sign-in's account page straight to Gmail, and nothing else", () => {
  const google = SITES.find((site) => site.googleItself);
  const [rule] = google.rules(DEFAULT_SETTINGS);
  equal(rule.action.redirect.url, 'https://mail.google.com/mail/');
  const pattern = new RegExp(rule.condition.regexFilter);
  ok(pattern.test('https://myaccount.google.com/?utm_source=sign_in_no_continue&pli=1'), 'after sign-in');
  ok(pattern.test('https://myaccount.google.com/?hl=en-GB&pli=1'), 'after sign-in, other order');
  ok(!pattern.test('https://myaccount.google.com/'), 'My Account by hand');
  ok(!pattern.test('https://myaccount.google.com/security?pli=10'), 'another page');
  equal(google.rules({ ...DEFAULT_SETTINGS, goToGoogleLanding: false }), [], 'option off');
});

test("sites' redirect rules have unique ids, and the hosts they redirect from are ones the extension can reach", () => {
  const rules = SITES.flatMap((site) => site.rules?.(DEFAULT_SETTINGS) ?? []);
  const ids = rules.map((rule) => rule.id);
  equal(new Set(ids).size, ids.length);
  ok(REGISTRY.accessFor(slack).includes('https://example.slack.com/*'), "Slack's, once granted");
});

test('a sign-in that takes steps: the first step showing that the run hasn\'t done', () => {
  const acme = flowSites.byId('acme');
  const APP = 'https://acme.example.test';
  const ID = 'https://login.acme.example.test';
  equal(acme.elements.step1.hosts, ['acme.example.test'], 'each step on its own host');
  equal(acme.elements.step2.hosts, ['login.acme.example.test']);
  equal(acme.elements.step2Email.label, "Acme's email box");

  const first = classify(acme, `${APP}/`, { found: { step1: true } });
  equal([first.step, first.siteStep, first.click, first.fillEmail, first.label], [STEP.LOGIN, 'step1', 'step1', undefined, "Acme's sign-in step 1"]);
  const email = classify(acme, `${ID}/login`, { found: { step2Email: true }, done: ['step1'] });
  equal([email.click, email.fillEmail], ['step2', 'step2Email'], 'an email step shows once its box does');
  equal(classify(acme, `${ID}/login`, { found: { step2: true }, done: ['step1'] }), null, 'its button alone is not the step');
  equal(classify(acme, `${ID}/login`, { found: { step2: true, step3: true }, done: ['step1', 'step2'] }).click, 'step3', 'same page, next step');
  equal(classify(acme, `${APP}/`, { found: { step1: true, step3: true }, done: ['step1'] }).click, 'step3', 'skips one it did');
  equal(classify(acme, `${APP}/`, { found: { step1: true }, done: ['step1'] }).click, 'step1', 'only done ones: the engine starts again');

  equal(classify(acme, `${ID}/account`, { settled: true }), null, 'never signed in on the sign-in host');
  equal(classify(acme, `${APP}/`, { settled: true }), null, 'nor on the page with its first step');
  equal(classify(acme, `${APP}/projects`, { settled: true }).step, STEP.SIGNED_IN);
  equal(classify(acme, `${APP}/mfa`, { found: { handover1: true } }).step, STEP.HANDOVER);
});
