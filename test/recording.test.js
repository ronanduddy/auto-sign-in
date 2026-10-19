// Recording a site (src/lib/recording.js): what I did while signing in, turned into a config entry.
import { test, equal, ok } from './harness.js';
import { addHost, lastRecorded, missedPages, noteGoogle, recordedSite, recordHandover, recordStep, startRecording } from '../src/lib/recording.js';
import { parseConfig } from '../src/config/schema.js';

const APP = 'acme.example.test';
const ID = 'login.acme.example.test';
const LOG_IN = { selectors: ['#log-in'], texts: ['Log in'] };
const CONTINUE = { selectors: ['#continue'], texts: ['Continue'] };
const GOOGLE = { selectors: ['#google'], texts: ['Continue with Google'] };

function recordAcme() {
  let r = startRecording({ tabId: 3, label: 'Acme', url: `https://${APP}/`, now: 1 });
  r = recordStep(r, { host: APP, path: '/', click: LOG_IN });
  r = addHost(r, ID);
  r = recordStep(r, { host: ID, path: '/login', click: CONTINUE, email: { selectors: ['#email'] } });
  r = recordStep(r, { host: ID, path: '/login', click: CONTINUE }); // the submit that followed the click
  r = recordStep(r, { host: ID, path: '/login', click: GOOGLE });
  r = noteGoogle(r, { url: `https://accounts.google.com/v3/signin/accountchooser?redirect_uri=https%3A%2F%2F${ID}%2Fcb`, appName: 'Acme' });
  return r;
}

test('a recording keeps each step once, with the email box that went with its click', () => {
  const r = recordAcme();
  equal(r.hosts, [APP, ID]);
  equal(r.steps.length, 3, 'the click and its submit are one step');
  equal(r.steps[1].email, { selectors: ['#email'] });
  equal(lastRecorded(r), '"Continue with Google"');
  equal(lastRecorded(recordStep(r, { host: ID, path: '/x', click: { selectors: ['#go'] } })), '#go');
  ok(r.google.seen && r.google.mentioned, "Google's address named the sign-in host");
});

test('a submit after the click can add the email box the click missed', () => {
  let r = startRecording({ tabId: 3, label: 'Acme', url: `https://${APP}/`, now: 1 });
  r = recordStep(r, { host: APP, path: '/login', click: CONTINUE });
  r = recordStep(r, { host: APP, path: '/login', click: CONTINUE, email: { selectors: ['#email'] } });
  equal(r.steps.length, 1);
  equal(r.steps[0].email, { selectors: ['#email'] });
});

test('the recording becomes a valid site with steps, its home where I clicked Done', () => {
  const { entry, notes } = recordedSite(recordAcme(), { doneUrl: `https://${APP}/projects?tab=1` });
  equal(entry, {
    type: 'button',
    label: 'Acme',
    host: APP,
    home: `https://${APP}/projects`,
    steps: [
      { path: '/', click: LOG_IN },
      { host: ID, path: '/login', email: { selectors: ['#email'] }, click: CONTINUE },
      { host: ID, path: '/login', click: GOOGLE },
    ],
  });
  equal(notes, { steps: [[], [], []], warnings: [] });
  equal(parseConfig({ version: 1, sites: [{ ...entry, id: 'acme' }] }).errors, []);
});

test("verification pages, Google's app name when its address doesn't say, and what to check", () => {
  let r = startRecording({ tabId: 3, label: 'Internal', url: 'https://internal.example.test/portal', now: 1 });
  r = recordStep(r, { host: 'internal.example.test', path: '/portal', click: { selectors: ['body > div > button'] }, fragile: true });
  r = noteGoogle(r, { url: 'https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Faccounts.google.com%2Fo%2Fsaml2', appName: 'Internal App' });
  r = recordHandover(r, { path: '/portal/mfa', selectors: ['#code'], kind: 'code' });
  r = recordHandover(r, { path: '/portal/mfa', selectors: ['#other'], kind: 'code' });
  r = recordStep(r, { host: 'internal.example.test', path: '/portal/home', click: { texts: ['Reports'] } });
  const { entry, notes } = recordedSite(r, { doneUrl: 'https://internal.example.test/' });
  equal(entry.google, { appNames: ['internal app'] }, "the SAML address doesn't name the host");
  equal(entry.handover, [{ path: '/portal/mfa', selectors: ['#code'] }], 'once per page');
  equal(entry.home, undefined, 'the root is the default home anyway');
  equal(notes.steps, [['found by its position on the page, so it may break'], ['after Google: probably not part of signing in']]);
});

test('says when nothing was clicked, Google never came up, or pages were missed', () => {
  const blank = startRecording({ tabId: 3, label: 'X', url: 'https://x.example.test/', now: 1 });
  equal(recordedSite(blank, { doneUrl: 'https://x.example.test/' }).notes.warnings.length, 2);
  const missed = missedPages(recordAcme());
  equal(recordedSite(missed, { doneUrl: 'https://x.example.test/' }).notes.warnings.length, 1, 'a host it could not see');
  equal(recordedSite(addHost(missed, 'idp.example.test'), { doneUrl: 'https://x.example.test/' }).notes.warnings, [], 'until it was added');
});

test('Done on another host makes that page the home page; Done on Google is ignored', () => {
  const r = startRecording({ tabId: 3, label: 'People', url: 'https://people.example.test/', now: 1 });
  equal(recordedSite(r, { doneUrl: 'https://payroll.example.test/dashboard?x=1' }).entry.home, 'https://payroll.example.test/dashboard');
  equal(recordedSite(r, { doneUrl: 'https://payroll.example.test/' }).entry.home, 'https://payroll.example.test/');
  equal(recordedSite(r, { doneUrl: 'https://accounts.google.com/x' }).entry.home, undefined);
  equal(recordedSite(r, { doneUrl: '' }).entry.home, undefined, 'unknown (Done from the popup on a hidden page)');
});
