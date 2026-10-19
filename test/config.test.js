// The config format (src/config/schema.js): defaults, the built-in presets, and errors people can act on.
import { test, equal, ok } from './harness.js';
import { DEFAULT_CONFIG, EMAIL_FIELDS, parseConfig } from '../src/config/schema.js';
import { buildRegistry } from '../src/sites/build.js';
import { FLOW_ENTRY } from './fixture.js';

const parse = (sites, extra = {}) => parseConfig({ version: 1, sites, ...extra });

test('the default config is just the Google loop and a New Google Meet link', () => {
  const { config, errors } = parseConfig(DEFAULT_CONFIG);
  equal(errors, []);
  equal(config.sites.map((site) => site.id), ['google']);
  equal(config.quickLinks, [{ label: 'New Google Meet', url: 'https://meet.google.com/new' }]);
});

test('config/example.json is valid and shows every kind of site', async () => {
  const raw = await (await fetch('../config/example.json')).json();
  const { config, errors } = parseConfig(raw);
  equal(errors, []);
  equal([...new Set(config.sites.map((site) => site.type))].sort(), ['button', 'google', 'slack']);
  ok(buildRegistry(config).sites.length === config.sites.length, 'builds');
});

const BUTTON = { type: 'button', id: 'dash', label: 'Dashboard', host: 'dash.example.test', signIn: { button: { texts: ['Sign in with Google'] } } };

test('a sign-in button site: defaults for everything but its host and button', () => {
  const { config, errors } = parse([{ ...BUTTON, labels: ['requires VPN'] }]);
  equal(errors, []);
  const [dash] = config.sites;
  equal(dash.matches, ['https://dash.example.test/*']);
  equal(dash.home, 'https://dash.example.test/');
  equal(dash.labels, ['requires VPN']);
  equal(dash.google, { mentions: ['dash.example.test'], appNames: [] });
  equal(dash.notSignedIn, ['/login*']);
  equal([dash.steps[0].name, dash.steps[0].path], ['signIn', '/login'], 'one sign-in button is the one step');
});

test('the built-ins need nothing, or just their workspace', () => {
  const { config, errors } = parse([{ preset: 'google' }, { preset: 'slack', workspace: 'acme', teamId: 'T0123ABCD' }]);
  equal(errors, []);
  equal(config.sites.map((site) => [site.id, site.label, site.type]), [
    ['google', 'Google', 'google'],
    ['slack', 'Slack', 'slack'],
  ]);
});

test('says what is wrong with a site, by number and name, and keeps the good ones', () => {
  const { config, errors } = parse([
    { ...BUTTON, host: undefined, label: 'Dashboard' },
    { preset: 'nope', id: 'x', label: 'X' },
    { type: 'slack', id: 'slack', label: 'Slack', workspace: 'acme' },
    { type: 'button', id: 'Bad Id', label: 'Bad', host: 'a.example.com', signIn: { button: { texts: ['Go'] } } },
    { type: 'button', id: 'no-button', label: 'No button', host: 'b.example.com' },
    BUTTON,
    BUTTON,
  ]);
  equal(config.sites.map((site) => site.id), ['dash'], 'only the valid, unique site');
  equal(errors, [
    'Site 1 ("Dashboard"): needs a host, such as "app.example.com".',
    'Site 2 ("X"): unknown preset "nope" (known: google, slack).',
    'Site 3 ("Slack"): needs a teamId, such as "T0123ABCD".',
    'Site 4 ("Bad"): needs an id: lower-case letters, digits and dashes.',
    'Site 5 ("No button"): signIn.button needs selectors or texts to find the sign-in button.',
    'Site 7 ("Dashboard"): the id "dash" is already used.',
  ]);
});

test('checks quick links, the version and the shape of the file', () => {
  equal(parseConfig([]).errors, ['The config must be a JSON object.']);
  equal(parseConfig({ version: 2, sites: [] }).errors[0], 'Unsupported config version 2; this extension reads version 1.');
  const { config, errors } = parse([], { quickLinks: [{ label: 'Meet', url: 'https://meet.google.com/new' }, { label: 'Bad', url: 'http://x' }] });
  equal(config.quickLinks.length, 1);
  equal(errors, ['Quick link 2: needs a label and an https:// url.']);
});

test('handover pages get readable defaults', () => {
  const { config, errors } = parse([
    { type: 'button', id: 'app', label: 'App', host: 'app.example.com', signIn: { button: { texts: ['Sign in'] } }, handover: [{ path: '/2fa', selectors: ['input'] }] },
  ]);
  equal(errors, []);
  equal(config.sites[0].handover[0], {
    path: '/2fa',
    selectors: ['input'],
    label: "App's verification code box",
    pageLabel: "App's verification page",
    waitingFor: 'your verification code',
  });
});

test("a sign-in that takes steps: each step's host joins the site, and gets readable labels", () => {
  const { config, errors } = parse([FLOW_ENTRY]);
  equal(errors, []);
  const [acme] = config.sites;
  equal(acme.matches, ['https://acme.example.test/*', 'https://login.acme.example.test/*']);
  equal(acme.google.mentions, ['acme.example.test', 'login.acme.example.test'], "either host in Google's address");
  equal(acme.signInHosts, ['login.acme.example.test']);
  equal(acme.notSignedIn, ['/'], 'only its own host\'s step pages, and "/" means the root page only');
  equal(acme.reloadOnInstall, ['https://acme.example.test/', 'https://login.acme.example.test/login*']);
  equal(
    acme.steps.map((step) => [step.name, step.host, step.label, step.pageLabel]),
    [
      ['step1', 'acme.example.test', 'Acme\'s "Log in" button', "Acme's sign-in step 1"],
      ['step2', 'login.acme.example.test', 'Acme\'s "Continue" button', "Acme's sign-in step 2"],
      ['step3', 'login.acme.example.test', 'Acme\'s "Continue with Google" button', "Acme's sign-in step 3"],
    ],
  );
  equal(acme.steps[1].email, { selectors: EMAIL_FIELDS }, 'the usual email boxes unless it says');
});

test('says what is wrong with a site\'s steps', () => {
  const { errors } = parse([
    { type: 'button', id: 'a', label: 'A', host: 'a.example.test', signIn: { button: { texts: ['Go'] } }, steps: [{ path: '/', click: { texts: ['Go'] } }] },
    { type: 'button', id: 'b', label: 'B', host: 'b.example.test', steps: [] },
    { type: 'button', id: 'c', label: 'C', host: 'c.example.test', steps: [{ click: { texts: ['Go'] } }, { path: '/x', host: 'Not A Host', email: 'yes' }] },
  ]);
  equal(errors, [
    'Site 1 ("A"): has both signIn and steps: use one or the other.',
    'Site 2 ("B"): steps needs at least one step.',
    'Site 3 ("C"): step 1 needs a path starting with "/".',
    'Site 3 ("C"): step 2: host must be a host name, such as "auth.example.com".',
    'Site 3 ("C"): step 2: email must be {} or { "selectors": [...] }.',
    'Site 3 ("C"): step 2 click needs selectors or texts to find the button to click after the email.',
  ]);
});

test('a home page on another host (the app on its own domain) is part of the site', () => {
  const { config, errors } = parse([
    { type: 'button', id: 'people', label: 'People', host: 'people.example.test', home: 'https://payroll.example.test/home', steps: [{ path: '/login', click: { texts: ['Login'] } }] },
  ]);
  equal(errors, []);
  const [site] = config.sites;
  equal(site.matches, ['https://people.example.test/*', 'https://payroll.example.test/*']);
  equal(site.google.mentions, ['people.example.test', 'payroll.example.test']);
  equal(site.signInHosts, [], 'signed in there, not a sign-in host');
});
