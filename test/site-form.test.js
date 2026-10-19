// The options page's site editing (src/options/site-form.js): recorded sites as a list of steps,
// new ids, and Slack's own section.
import { test, equal, ok } from './harness.js';
import {
  describeHandover,
  describeStep,
  duplicateEntry,
  hostFrom,
  nameFromAddress,
  siteHostsOf,
  slackFromForm,
  stepsEditable,
  stillDisabled,
  uniqueId,
  withHosts,
  withSlack,
} from '../src/options/site-form.js';
import { CONFIG, FLOW_ENTRY } from './fixture.js';

const raw = await (await fetch('./sites.json')).json();

test('a site with steps shows them as a list, one line each', () => {
  ok(stepsEditable(FLOW_ENTRY));
  ok(!stepsEditable({ ...FLOW_ENTRY, notSignedIn: ['/x'] }), 'anything else in it: JSON');
  ok(!stepsEditable(raw.sites.find((site) => site.id === 'internal')), 'a site with signIn: JSON');
  ok(!stepsEditable({ preset: 'google' }), 'nor a built-in');
  equal(
    FLOW_ENTRY.steps.map((step) => describeStep(step, FLOW_ENTRY.host)),
    [
      'On /: click "Log in"',
      'On login.acme.example.test/login: fill in your email, then click "Continue"',
      'On login.acme.example.test/login: click "Continue with Google"',
    ],
  );
  equal(describeStep({ path: '/x', click: { selectors: ['#go'] } }, 'a'), 'On /x: click the element #go');
  equal(describeHandover(FLOW_ENTRY.handover[0]), 'On /mfa: hand over to you at input[name="code"]');
});

test('new ids come from the name and never clash', () => {
  const taken = new Set(CONFIG.sites.map((site) => site.id));
  equal(uniqueId('Acme Dashboard!', taken), 'acme-dashboard');
  equal(uniqueId('Slack', taken), 'slack-2', 'taken');
  equal(uniqueId('!!!', new Set()), 'site');
});

test("Slack's section: a workspace and its team ID, from an ID or a pasted address", () => {
  equal(slackFromForm({ workspace: 'acme', teamId: 'T0123ABCD' }), { workspace: 'acme', teamId: 'T0123ABCD' });
  equal(slackFromForm({ workspace: ' https://Acme.slack.com/ ', teamId: 'https://app.slack.com/client/T0123ABCD/C0456' }), { workspace: 'acme', teamId: 'T0123ABCD' });
  equal(slackFromForm({ workspace: 'acme', teamId: 't0123abcd' }).teamId, 'T0123ABCD');
  equal(slackFromForm({ workspace: '', teamId: '' }), { none: true }, 'both empty: no Slack');
  equal(slackFromForm({ workspace: 'acme', teamId: '' }).problems.length, 1);
  equal(slackFromForm({ workspace: 'not a workspace', teamId: 'https://example.com/' }).problems.length, 2);
});

test("Slack's section changes only the Slack site in the config, keeping its name and labels", () => {
  const sites = [{ preset: 'google' }, { preset: 'slack', label: 'Work Slack', labels: ['work'], workspace: 'old', teamId: 'T1' }];
  equal(withSlack(sites, { workspace: 'acme', teamId: 'T2' })[1], { preset: 'slack', label: 'Work Slack', labels: ['work'], workspace: 'acme', teamId: 'T2' });
  equal(withSlack(sites, { none: true }), [{ preset: 'google' }], 'left empty: no Slack site');
  equal(withSlack([{ preset: 'google' }], { workspace: 'acme', teamId: 'T2' })[1], { preset: 'slack', workspace: 'acme', teamId: 'T2' }, 'added');
});

test("a recorded site without a name is named after its address, with its environment in brackets", () => {
  equal(nameFromAddress('https://app.acme.com/'), 'Acme');
  equal(nameFromAddress('https://acmepeople.com/login'), 'Acmepeople');
  equal(nameFromAddress('https://www.example.co.uk/'), 'Example');
  equal(nameFromAddress('https://login.acme.example.test/'), 'Acme', '.test is the top-level domain, not an environment');
  equal(nameFromAddress('https://dashboard.staging.example.com/'), 'Dashboard (staging)');
  equal(nameFromAddress('https://dashboard.production.example.com/'), 'Dashboard (production)');
  equal(nameFromAddress('https://deploys.staging2.uk.example.com/'), 'Deploys (staging2)', 'with its number');
  equal(nameFromAddress('https://internal-training.example.com/'), 'Internal (training)', 'part of a hyphenated name');
  equal(nameFromAddress('https://uat-portal.acme.com/'), 'Acme (uat)');
  equal(nameFromAddress('https://internal.local/portal'), 'Internal (local)');
  equal(nameFromAddress('https://acme-people.com/'), 'Acme people');
  equal(nameFromAddress('https://dev.to/'), 'Dev', 'nothing but an environment: the address as it is');
  equal(nameFromAddress('not an address'), 'Site');
});

test("duplicating a site: every host it uses, swapped wherever it appears, whole hosts only", () => {
  const internal = raw.sites.find((site) => site.id === 'internal');
  equal(siteHostsOf(FLOW_ENTRY), ['acme.example.test', 'login.acme.example.test']);
  equal(siteHostsOf(internal), ['internal.example.test']);
  equal(siteHostsOf({ host: 'a.example.test', matches: ['https://*.example.test/*'], home: 'https://accounts.google.com/x' }), ['a.example.test'], 'no wildcard or Google hosts');

  const staging = withHosts(internal, { 'internal.example.test': 'internal.staging.example.test' });
  equal(staging.host, 'internal.staging.example.test');
  equal(staging.home, 'https://internal.staging.example.test/portal');
  equal(staging.matches, ['https://internal.staging.example.test/portal*']);
  equal(staging.reloadOnInstall[0], 'https://internal.staging.example.test/portal');
  equal(staging.signIn, internal.signIn, 'selectors without the host are untouched');

  const flow = withHosts(FLOW_ENTRY, { 'acme.example.test': 'acme.staging.example.test' });
  equal(flow.steps[1].host, 'login.acme.example.test', "login.acme.example.test isn't acme.example.test");
  const both = withHosts(FLOW_ENTRY, { 'acme.example.test': 'login.acme.example.test', 'login.acme.example.test': 'acme.example.test' });
  equal([both.host, both.steps[1].host], ['login.acme.example.test', 'acme.example.test'], 'swapped in one go');
  equal(withHosts({ click: { selectors: ['a[href="https://acme.example.test/sso"]'] } }, { 'acme.example.test': 'acme.staging.example.test' }).click.selectors, ['a[href="https://acme.staging.example.test/sso"]'], 'links in selectors too');
});

test('a duplicate has no id, its own name and labels, and is a valid site', () => {
  const copy = duplicateEntry({ ...FLOW_ENTRY, labels: ['requires VPN'] }, { hosts: { 'acme.example.test': 'acme.staging.example.test' }, label: 'Acme (staging)', labels: ['staging'] });
  equal([copy.id, copy.label, copy.labels, copy.host], [undefined, 'Acme (staging)', ['staging'], 'acme.staging.example.test']);
  equal(hostFrom(' https://Acme.Staging.example.test/login '), 'acme.staging.example.test');
  equal(hostFrom('acme.example.test'), 'acme.example.test');
  equal(hostFrom(''), '');
});

test('disabling is the exception: added sites start enabled, removed ones leave the list', () => {
  equal(stillDisabled(['dash', 'old', 'acme'], ['dash', 'acme', 'google'], ['acme']), ['dash'], "removed ('old') and re-added ('acme') come off");
  equal(stillDisabled(undefined, ['dash']), []);
});
