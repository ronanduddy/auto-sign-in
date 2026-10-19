// The config: which sites to sign in to, plus quick links for the popup. It's a versioned JSON
// document, kept in chrome.storage.local and imported or exported as a file from the options page.
// Your Google email and switches like dry run are personal settings, kept apart, so a config
// file can be shared without anyone's details in it. config/example.json shows every option.
//
// parseConfig() checks a document and fills in defaults. Nothing in it is code: sites are
// addresses, button texts, CSS selectors and plain-text app names (no regular expressions).

import { PRESETS } from '../sites/presets.js';

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  quickLinks: [{ label: 'New Google Meet', url: 'https://meet.google.com/new' }],
  sites: [{ preset: 'google' }],
});

const ID = /^[a-z0-9][a-z0-9-]*$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const list = (value) => (value === undefined ? [] : [].concat(value));

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// A preset's values (src/sites/presets.js), overridden by the site's own.
function withPreset(entry) {
  const preset = PRESETS[entry.preset];
  return preset ? { ...preset, ...entry } : null;
}

function textList(value, field, problems) {
  const items = list(value);
  if (!items.every(isText)) problems.push(`${field} must be text or a list of text`);
  return items.filter(isText).map((item) => item.trim());
}

// The boxes an email step fills in when the config doesn't say which.
export const EMAIL_FIELDS = [
  'input[type="email"]',
  'input[autocomplete~="email"]',
  'input[autocomplete~="username"]',
  'input[name="email"]',
  'input[name="username"]',
];

// How to find a button or link: CSS selectors and/or its whole text.
function clickTarget(value, field, what, problems) {
  const target = isObject(value) ? value : {};
  const selectors = textList(target.selectors, `${field}.selectors`, problems);
  const texts = textList(target.texts, `${field}.texts`, problems);
  if (!selectors.length && !texts.length) problems.push(`${field} needs selectors or texts to find ${what}`);
  return { ...(selectors.length && { selectors }), ...(texts.length && { texts }) };
}

function reloadMinutes(value, field, problems) {
  if (value === undefined) return {};
  if (!(typeof value === 'number' && value > 0)) {
    problems.push(`${field} must be a positive number`);
    return {};
  }
  return { reloadIfOlderThanMs: value * 60_000 };
}

// The site's own pages before (or between) Google's: either one sign-in button (signIn), or a
// list of steps, each a rule for one page: click something, or fill in your email and click.
// Steps are named signIn (the one-button form) or step1, step2… (the elements' names).
function normaliseSteps(site, name, problems) {
  if (site.steps === undefined) {
    const signIn = isObject(site.signIn) ? site.signIn : {};
    const path = signIn.path ?? '/login';
    if (!isText(path) || !path.startsWith('/')) problems.push('signIn.path must start with "/"');
    return [
      {
        name: 'signIn',
        path,
        button: clickTarget(signIn.button, 'signIn.button', 'the sign-in button', problems),
        ...reloadMinutes(signIn.reloadIfOlderThanMinutes, 'signIn.reloadIfOlderThanMinutes', problems),
        label: `${name}'s sign-in button`,
        pageLabel: `${name}'s sign-in page`,
      },
    ];
  }
  if (site.signIn !== undefined) problems.push('has both signIn and steps: use one or the other');
  const steps = list(site.steps);
  if (!steps.length) problems.push('steps needs at least one step');
  return steps
    .map((step, i) => {
      const where = `step ${i + 1}`;
      if (!isObject(step)) {
        problems.push(`${where} must be an object`);
        return null;
      }
      if (!isText(step.path) || !step.path.startsWith('/')) problems.push(`${where} needs a path starting with "/"`);
      if (step.host !== undefined && !(isText(step.host) && HOST.test(step.host))) {
        problems.push(`${where}: host must be a host name, such as "auth.example.com"`);
      }
      let email = null;
      if (step.email !== undefined) {
        const selectors = isObject(step.email) ? textList(step.email.selectors, `${where} email.selectors`, problems) : [];
        if (step.email !== true && !isObject(step.email)) problems.push(`${where}: email must be {} or { "selectors": [...] }`);
        email = { selectors: selectors.length ? selectors : EMAIL_FIELDS };
      }
      const button = clickTarget(step.click, `${where} click`, email ? 'the button to click after the email' : 'what to click', problems);
      const text = button.texts?.[0];
      return {
        name: `step${i + 1}`,
        path: step.path,
        ...(step.host !== undefined && { host: step.host }),
        button,
        ...(email && { email }),
        ...reloadMinutes(step.reloadIfOlderThanMinutes, `${where} reloadIfOlderThanMinutes`, problems),
        label: isText(step.label) ? step.label : text ? `${name}'s "${text}" button` : `${name}'s step ${i + 1} button`,
        pageLabel: steps.length === 1 ? `${name}'s sign-in page` : `${name}'s sign-in step ${i + 1}`,
      };
    })
    .filter(Boolean);
}

// A path rule (see notSignedIn) for a step's page: everything under it, except that "/" means the
// root page only, or every page would count as signed out.
const underPath = (path) => (path === '/' ? '/' : `${path}*`);

function normaliseButton(site, name, problems) {
  const host = site.host ?? (site.matches ? safeHost(list(site.matches)[0]) : null);
  if (!isText(host) || !HOST.test(host)) {
    problems.push('needs a host, such as "app.example.com"');
    return null;
  }
  const steps = normaliseSteps(site, name, problems);
  // Steps on another host (an identity provider's sign-in, say) bring that host into the site.
  const otherHosts = [...new Set(steps.map((step) => step.host).filter((h) => h && h !== host))];
  // With more than one host, a step without one is on the site's own host.
  if (otherHosts.length) for (const step of steps) step.host ??= host;
  const onMainHost = steps.filter((step) => !step.host || step.host === host);

  const home = site.home ?? `https://${host}/`;
  if (!isHttpsUrl(home)) problems.push('home must be an https:// address');
  // A home page on another host (the app, once signed in, on its own domain) is the site's too:
  // signing in is done there.
  const homeHost = isHttpsUrl(home) ? new URL(home).hostname : null;
  const siteHosts = [...new Set([host, ...otherHosts, ...(homeHost ? [homeHost] : [])])];
  const matches = list(site.matches ?? siteHosts.map((h) => `https://${h}/*`));
  if (!matches.every((pattern) => isText(pattern) && pattern.startsWith('https://'))) {
    problems.push('matches must be https:// address patterns');
  }

  const handover = list(site.handover).map((page, i) => {
    if (!isObject(page) || !isText(page.path) || !page.path.startsWith('/')) {
      problems.push(`handover ${i + 1} needs a path starting with "/"`);
      return null;
    }
    const pageSelectors = textList(page.selectors, `handover ${i + 1} selectors`, problems);
    if (!pageSelectors.length) problems.push(`handover ${i + 1} needs selectors for its code box`);
    return {
      path: page.path,
      selectors: pageSelectors,
      label: isText(page.label) ? page.label : `${name}'s verification code box`,
      pageLabel: isText(page.pageLabel) ? page.pageLabel : `${name}'s verification page`,
      waitingFor: isText(page.waitingFor) ? page.waitingFor : 'your verification code',
    };
  });

  const google = isObject(site.google) ? site.google : {};
  const unique = (items) => [...new Set(items)];

  return {
    type: 'button',
    home,
    matches,
    steps,
    // Pages on a sign-in-only host never count as signed in.
    signInHosts: otherHosts,
    google: {
      mentions: google.mentions === undefined ? siteHosts : textList(google.mentions, 'google.mentions', problems),
      appNames: textList(google.appNames ?? google.appName, 'google.appNames', problems),
    },
    handover: handover.filter(Boolean),
    notSignedIn:
      site.notSignedIn === undefined ? unique(onMainHost.map((step) => underPath(step.path))) : textList(site.notSignedIn, 'notSignedIn', problems),
    reloadOnInstall:
      site.reloadOnInstall === undefined
        ? unique(steps.map((step) => `https://${step.host ?? host}${step.path === '/' ? '/' : `${step.path}*`}`))
        : textList(site.reloadOnInstall, 'reloadOnInstall', problems),
  };
}

function safeHost(pattern) {
  try {
    return new URL(String(pattern).replace(/\*/g, 'x')).hostname;
  } catch {
    return null;
  }
}

// "Site 3 ("Dashboard"): <problem>." so people can find the entry in their file.
function describe(index, label, problem) {
  return `Site ${index + 1}${isText(label) ? ` ("${label}")` : ''}: ${problem}.`;
}

function normaliseSite(entry, index) {
  const problems = [];
  if (!isObject(entry)) return { problems: [describe(index, null, 'must be an object')] };
  let site = entry;
  if (entry.preset !== undefined) {
    site = withPreset(entry);
    if (!site) return { problems: [describe(index, entry.label, `unknown preset "${entry.preset}" (known: ${Object.keys(PRESETS).join(', ')})`)] };
  }
  const type = site.type;
  const id = site.id ?? (type === 'google' ? 'google' : undefined);
  const label = site.label ?? (type === 'google' ? 'Google' : undefined);
  if (!isText(id) || !ID.test(id)) problems.push('needs an id: lower-case letters, digits and dashes');
  if (!isText(label)) problems.push('needs a label');
  const labels = textList(site.labels, 'labels', problems);

  let details;
  if (type === 'google') {
    details = { type: 'google' };
  } else if (type === 'slack') {
    if (!isText(site.workspace) || !/^[a-z0-9-]+$/.test(site.workspace)) problems.push('needs a workspace, such as "acme" for acme.slack.com');
    if (!isText(site.teamId) || !/^[A-Z0-9]+$/.test(site.teamId)) problems.push('needs a teamId, such as "T0123ABCD"');
    details = { type: 'slack', workspace: site.workspace, teamId: site.teamId };
  } else if (type === 'button') {
    details = normaliseButton(site, isText(label) ? label : 'this site', problems);
  } else {
    problems.push(`unknown type "${type}" (known: button, slack, google)`);
  }
  if (problems.length) return { problems: problems.map((problem) => describe(index, label, problem)) };
  return { site: { id, label, labels, ...details } };
}

export function parseConfig(raw) {
  const errors = [];
  if (!isObject(raw)) return { config: { ...DEFAULT_CONFIG, sites: [] }, errors: ['The config must be a JSON object.'] };
  const version = raw.version ?? CONFIG_VERSION;
  if (version !== CONFIG_VERSION) errors.push(`Unsupported config version ${version}; this extension reads version ${CONFIG_VERSION}.`);

  const quickLinks = [];
  list(raw.quickLinks).forEach((link, i) => {
    if (isObject(link) && isText(link.label) && isHttpsUrl(link.url)) quickLinks.push({ label: link.label.trim(), url: link.url });
    else errors.push(`Quick link ${i + 1}: needs a label and an https:// url.`);
  });

  const sites = [];
  const seen = new Set();
  list(raw.sites).forEach((entry, i) => {
    const { site, problems } = normaliseSite(entry, i);
    if (problems) {
      errors.push(...problems);
      return;
    }
    if (seen.has(site.id)) {
      errors.push(`Site ${i + 1} ("${site.label}"): the id "${site.id}" is already used.`);
      return;
    }
    seen.add(site.id);
    sites.push(site);
  });
  if (sites.filter((site) => site.type === 'google').length > 1) errors.push('Only one Google site is allowed.');
  if (sites.filter((site) => site.type === 'slack').length > 1) errors.push('Only one Slack workspace is supported.');

  return { config: { version: CONFIG_VERSION, quickLinks, sites }, errors };
}
