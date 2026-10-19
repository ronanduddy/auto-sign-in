import {
  BADGE_CLEAR_MS,
  DEFAULT_SETTINGS,
  GUARD_MAX_RUNS,
  GUARD_WINDOW_MS,
  LOG_SIZE,
  RUN_WINDOW_MS,
  WAIT_WINDOW_MS,
} from '../lib/config.js';
import { BADGE } from '../lib/engine.js';
import { DEFAULT_CONFIG, parseConfig } from '../config/schema.js';
import { buildRegistry } from '../sites/build.js';
import { STALE_MS, isLandingUrl } from '../sites/types/slack.js';
import { slackFromForm, withSlack } from './site-form.js';
import { badSelectors, setUpSitesEditor } from './sites-editor.js';

const $ = (id) => document.getElementById(id);
const minutes = (ms) => String(ms / 60_000);

// The config as stored. The sites editor (sites-editor.js) changes it; Slack's section and the
// explainer below follow it.
const { config: stored } = await chrome.storage.local.get('config');
const editor = setUpSitesEditor({ raw: structuredClone(stored ?? DEFAULT_CONFIG), onChange: applyConfig });
let shownSlack = null; // the workspace Slack's section was last filled in from
applyConfig(editor.config());

function applyConfig(raw) {
  const { config, errors } = parseConfig(raw);
  const sites = buildRegistry(config);
  // Entries this version can't use (an old preset, say) are left out of the list: say which.
  $('config-problems').hidden = errors.length === 0;
  $('config-problem-list').replaceChildren(...errors.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
  const slack = sites.tracked?.workspace ? sites.tracked.workspace : null;
  // Only when the config's workspace changed, so a save elsewhere doesn't undo typing here.
  const key = slack ? `${slack.host} ${slack.teamId}` : '';
  if (key !== shownSlack) {
    shownSlack = key;
    $('slackWorkspace').value = slack?.host.replace(/\.slack\.com$/, '') ?? '';
    $('slackTeamId').value = slack?.teamId ?? '';
    $('landingUrl').placeholder = `https://app.slack.com/client/${slack?.teamId ?? 'T0123ABCD'}/C0123ABCD`;
  }
  fillFacts({
    siteList: sites.byLabel().map((site) => site.label).join(', '),
    team: slack?.host ?? 'your Slack workspace',
    teamUrl: slack?.url ?? 'your workspace',
  });
}

// The "What it does" section quotes these, so it can't drift from what the extension does.
function fillFacts(facts) {
  for (const el of document.querySelectorAll('[data-fact]')) {
    if (el.dataset.fact in facts) el.textContent = facts[el.dataset.fact];
  }
}

fillFacts({
  staleMinutes: minutes(STALE_MS),
  runMinutes: minutes(RUN_WINDOW_MS),
  waitMinutes: minutes(WAIT_WINDOW_MS),
  guardRuns: String(GUARD_MAX_RUNS),
  guardMinutes: minutes(GUARD_WINDOW_MS),
  badgeMinutes: minutes(BADGE_CLEAR_MS),
  logSize: String(LOG_SIZE),
});

for (const el of document.querySelectorAll('[data-badge]')) {
  const badge = BADGE[el.dataset.badge];
  el.className = 'badge';
  el.textContent = badge.text;
  el.style.background = badge.color;
}

const describeEmail = (email) => email || 'the account you set above';

// Each landing address only applies while the switch above it is on.
const DEPENDENT_FIELDS = { goToGoogleLanding: 'googleLandingUrl', goToSlackLanding: 'landingUrl' };

function syncDependentFields() {
  for (const [toggle, field] of Object.entries(DEPENDENT_FIELDS)) $(field).disabled = !$(toggle).checked;
}

for (const toggle of Object.keys(DEPENDENT_FIELDS)) $(toggle).addEventListener('change', syncDependentFields);

// The popup's quick links: a name and an address per row, saved with the rest of the form.
function quickLinkRow({ label = '', url = '' } = {}) {
  const row = Object.assign(document.createElement('div'), { className: 'quick-link' });
  const name = Object.assign(document.createElement('input'), { type: 'text', value: label, placeholder: 'New Google Meet' });
  const address = Object.assign(document.createElement('input'), { type: 'url', value: url, placeholder: 'https://meet.google.com/new' });
  name.setAttribute('aria-label', 'Link name');
  address.setAttribute('aria-label', 'Link address');
  const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary small', textContent: 'Remove' });
  remove.addEventListener('click', () => row.remove());
  row.append(name, address, remove);
  return row;
}

$('quick-links').replaceChildren(...(editor.config().quickLinks ?? []).map(quickLinkRow));
$('add-quick-link').addEventListener('click', () => {
  const row = quickLinkRow();
  $('quick-links').append(row);
  row.querySelector('input').focus();
});

// The filled-in rows (a row left empty is ignored).
function quickLinks() {
  return [...document.querySelectorAll('.quick-link')]
    .map((row) => {
      const [name, address] = row.querySelectorAll('input');
      return { label: name.value.trim(), url: address.value.trim() };
    })
    .filter((link) => link.label || link.url);
}

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const current = { ...DEFAULT_SETTINGS, ...settings };
  $('email').value = current.email;
  $('landingUrl').value = current.landingUrl;
  // On by default, but only once there's a page to land on.
  $('goToSlackLanding').checked = current.goToSlackLanding && Boolean(current.landingUrl);
  $('skipDesktopPrompt').checked = current.skipDesktopPrompt;
  $('submitAutofilledPassword').checked = current.submitAutofilledPassword;
  $('googleTwoStepAssist').checked = current.googleTwoStepAssist;
  $('goToGoogleLanding').checked = current.goToGoogleLanding;
  $('googleLandingUrl').value = current.googleLandingUrl;
  fillFacts({ email: describeEmail(current.email) });
  syncDependentFields();
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('email').value.trim();
  const landingUrl = $('landingUrl').value.trim();
  const emailOk = /^[^\s@]+@[^\s@]+$/.test(email);
  const slack = slackFromForm({ workspace: $('slackWorkspace').value, teamId: $('slackTeamId').value });
  const landingOk = !$('goToSlackLanding').checked || isLandingUrl(landingUrl);
  const googleLandingUrl = $('googleLandingUrl').value.trim();
  const googleLandingOk = !$('goToGoogleLanding').checked || /^https:\/\/[^\s/]+/.test(googleLandingUrl);
  const links = quickLinks();
  const linksOk = links.every((link) => link.label && /^https:\/\/[^\s/]+/.test(link.url));
  $('email-error').hidden = emailOk;
  $('quick-links-error').hidden = linksOk;
  $('slack-error').textContent = slack.problems?.join(' ') ?? '';
  $('slack-error').hidden = !slack.problems;
  $('landing-error').hidden = landingOk;
  $('google-landing-error').hidden = googleLandingOk;
  $('email').setAttribute('aria-invalid', String(!emailOk));
  $('slackWorkspace').setAttribute('aria-invalid', String(Boolean(slack.problems)));
  $('slackTeamId').setAttribute('aria-invalid', String(Boolean(slack.problems)));
  $('landingUrl').setAttribute('aria-invalid', String(!landingOk));
  $('googleLandingUrl').setAttribute('aria-invalid', String(!googleLandingOk));
  if (!emailOk || slack.problems || !landingOk || !googleLandingOk || !linksOk) {
    $('saved').textContent = '';
    return;
  }

  // Slack's site and the quick links are part of the config. A Slack workspace's access is asked
  // for in this click, before anything waits (a permission prompt needs the click).
  const config = editor.config();
  const next = { ...config, quickLinks: links, sites: withSlack(config.sites, slack) };
  const changed = JSON.stringify(next) !== JSON.stringify({ ...config, quickLinks: config.quickLinks ?? [] });
  if (changed && !slack.none) {
    const registry = buildRegistry(parseConfig({ version: next.version, sites: withSlack([], slack) }).config);
    await chrome.permissions.request({ origins: registry.accessFor(registry.sites[0]) }).catch(() => false);
  }

  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: {
      ...DEFAULT_SETTINGS,
      ...settings,
      email,
      landingUrl,
      skipDesktopPrompt: $('skipDesktopPrompt').checked,
      goToSlackLanding: $('goToSlackLanding').checked,
      submitAutofilledPassword: $('submitAutofilledPassword').checked,
      googleTwoStepAssist: $('googleTwoStepAssist').checked,
      goToGoogleLanding: $('goToGoogleLanding').checked,
      googleLandingUrl,
    },
  });
  if (changed) await editor.commit(next);
  // Show what was saved: the workspace's name and its T… ID, however they were typed or pasted.
  $('slackWorkspace').value = slack.workspace ?? '';
  $('slackTeamId').value = slack.teamId ?? '';
  fillFacts({ email: describeEmail(email) });
  $('saved').textContent = 'Saved.';
});

load();

// Import and export of the config (sites and quick links), as a JSON file.
let pendingImport = null;

function listItems(element, items) {
  element.replaceChildren(...items.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
}

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    showImportProblems([`${file.name} isn't valid JSON.`]);
    return;
  }
  const { config: parsed, errors } = parseConfig(raw);
  const problems = errors.length ? errors : badSelectors(parsed);
  if (problems.length) {
    showImportProblems(problems);
    return;
  }
  pendingImport = raw;
  $('import-title').textContent = `Use ${file.name}?`;
  listItems($('import-summary'), [
    ...buildRegistry(parsed)
      .byLabel()
      .map((site) => `${site.label}: ${[...new Set(site.matches.map((m) => new URL(m.replace(/\*/g, 'x')).host))].join(', ')}`),
    ...parsed.quickLinks.map((link) => `Quick link: ${link.label} (${link.url})`),
  ]);
  $('import-problems').hidden = true;
  $('import-use').hidden = false;
  $('import-review').hidden = false;
});

function showImportProblems(problems) {
  pendingImport = null;
  $('import-title').textContent = "That file can't be used:";
  listItems($('import-problems'), problems);
  $('import-problems').hidden = false;
  $('import-summary').replaceChildren();
  $('import-use').hidden = true;
  $('import-review').hidden = false;
}

$('import-use').addEventListener('click', async () => {
  if (!pendingImport) return;
  // Ask for every site's access in this click (a permission prompt needs one). Saying no still
  // saves the config; those sites show as disabled, with Enable, until you allow them.
  const imported = buildRegistry(parseConfig(pendingImport).config);
  const access = [...new Set(imported.sites.flatMap((site) => imported.accessFor(site)))];
  if (access.length) await chrome.permissions.request({ origins: access }).catch(() => false);
  // Every imported site starts enabled.
  await editor.commit(pendingImport, { added: imported.sites.map((site) => site.id) });
  location.reload();
});

$('import-cancel').addEventListener('click', () => {
  pendingImport = null;
  $('import-review').hidden = true;
});

$('export').addEventListener('click', async () => {
  const blob = new Blob([`${JSON.stringify(editor.config(), null, 2)}\n`], { type: 'application/json' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'auto-sign-in-config.json' });
  link.click();
  URL.revokeObjectURL(link.href);
});
