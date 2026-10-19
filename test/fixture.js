// The sites the tests run against: test/sites.json (made-up sites on example hosts, one of each
// shape the extension handles), parsed and built exactly as the extension does with an imported
// config.
import { parseConfig } from '../src/config/schema.js';
import { buildRegistry } from '../src/sites/build.js';

const raw = await (await fetch('./sites.json')).json();
const parsed = parseConfig(raw);
if (parsed.errors.length) throw new Error(`test/sites.json: ${parsed.errors.join(' ')}`);

export const CONFIG = parsed.config;
export const sites = buildRegistry(parsed.config);

// A site whose sign-in takes a few steps, on example hosts: "Log in" on the app, then on an
// identity provider's host the email and Continue, then its Google button (on the same page,
// once the email is in). Its own code page comes after Google.
export const FLOW_ENTRY = {
  type: 'button',
  id: 'acme',
  label: 'Acme',
  host: 'acme.example.test',
  steps: [
    { path: '/', click: { texts: ['Log in'] } },
    { host: 'login.acme.example.test', path: '/login', email: {}, click: { texts: ['Continue'] } },
    { host: 'login.acme.example.test', path: '/login', click: { texts: ['Continue with Google'] } },
  ],
  handover: [{ path: '/mfa', selectors: ['input[name="code"]'] }],
};
export const flowSites = buildRegistry(parseConfig({ version: 1, sites: [FLOW_ENTRY] }).config);
