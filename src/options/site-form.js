// The options page's site editing, as plain functions: a recorded site shown as a list of its
// steps (with its name and labels), new site ids, and Slack's own section. No DOM here, so it can
// be unit tested; sites-editor.js and options.js draw the page.

export const FIELDS = {
  label: { title: 'Name', placeholder: 'Acme dashboard', required: true },
  labels: { title: 'Labels', placeholder: 'requires VPN, staging', hint: 'Shown beside the site. Separate with commas.' },
};

// A site with steps (recorded, or written by hand) is shown as a list of its steps, with its name
// and labels in the form, as long as everything else in it is something the list shows. Any
// other site opens as JSON, so nothing gets dropped.
export function stepsEditable(entry) {
  if (entry?.type !== 'button' || !Array.isArray(entry.steps)) return false;
  const only = (object, keys) => object !== null && typeof object === 'object' && Object.keys(object).every((key) => keys.includes(key));
  return (
    only(entry, ['type', 'id', 'label', 'labels', 'host', 'home', 'steps', 'handover', 'google']) &&
    entry.steps.every((step) => only(step, ['host', 'path', 'email', 'click'])) &&
    (entry.handover ?? []).every((page) => only(page, ['path', 'selectors'])) &&
    only(entry.google ?? {}, ['appNames'])
  );
}

const what = (click) => (click?.texts?.[0] ? `"${click.texts[0]}"` : `the element ${click?.selectors?.[0] ?? '(none)'}`);

// One line per step, for the list: where, and what the run does there.
export function describeStep(step, siteHost) {
  const page = `${step.host && step.host !== siteHost ? step.host : ''}${step.path}`;
  return `On ${page}: ${step.email ? `fill in your email, then click ${what(step.click)}` : `click ${what(step.click)}`}`;
}

export function describeHandover(page) {
  return `On ${page.path}: hand over to you at ${page.selectors?.[0] ?? 'the code box'}`;
}

// A site id from its name: lower-case, dashes, and unique among the ids already taken.
export function uniqueId(label, taken) {
  const base =
    String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'site';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

// Slack's section: the workspace (acme, or acme.slack.com) and its team ID (T0123ABCD, or any
// app.slack.com/client/T… address, which starts with it). Both empty: no Slack.
// Returns { workspace, teamId }, { none: true }, or { problems }.
export function slackFromForm({ workspace, teamId }) {
  const name = String(workspace ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.slack\.com(\/.*)?$/, '');
  const idText = String(teamId ?? '').trim();
  if (!name && !idText) return { none: true };
  const id = /(?:^|\/client\/)(T[A-Z0-9]+)(?:[/?#]|$)/i.exec(idText)?.[1]?.toUpperCase();
  const problems = [];
  if (!/^[a-z0-9-]+$/.test(name)) problems.push('Fill in the workspace: the part before .slack.com, such as "acme".');
  if (!id) problems.push('Fill in the team ID: the T… part of the address when the workspace is open at app.slack.com.');
  return problems.length ? { problems } : { workspace: name, teamId: id };
}

const isSlack = (entry) => entry?.preset === 'slack' || entry?.type === 'slack';

// The config's sites with Slack's section applied: the workspace set (keeping the entry's own id,
// name and labels), or the Slack site taken out when the workspace was left empty.
export function withSlack(entries, slack) {
  const index = entries.findIndex(isSlack);
  if (slack.none) return index < 0 ? entries : entries.filter((_, i) => i !== index);
  const entry = { ...(index < 0 ? { preset: 'slack' } : entries[index]), workspace: slack.workspace, teamId: slack.teamId };
  return index < 0 ? [...entries, entry] : entries.map((existing, i) => (i === index ? entry : existing));
}

// Parts of a host that name its role rather than the site: app.acme.com is "Acme".
const GENERIC_HOST_PARTS = new Set(['www', 'app', 'apps', 'login', 'auth', 'sso', 'signin', 'id', 'accounts', 'account', 'portal', 'my', 'secure', 'web']);

// Parts that say which copy of a site it is (staging, training…), kept in brackets in its name so
// copies of one site can be told apart. A number may follow: staging2.
const ENVIRONMENT = /^(staging|stage|stg|training|train|dev|development|test|testing|qa|uat|sandbox|demo|preprod|production|prod|beta|local)\d*$/;

// A name for a site from its address, when none was given: its first meaningful part,
// capitalised, and the environment if the address names one (acmepeople.com is "Acmepeople";
// dashboard.staging.example.com is "Dashboard (staging)"; internal-training.example.com is
// "Internal (training)").
export function nameFromAddress(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'Site';
  }
  const labels = host.split('.');
  // The last part is the top-level domain (.com), except on a machine name such as internal.local.
  const top = labels.at(-1);
  let environment = labels.length > 1 && top === 'local' ? top : null;
  let name = null;
  for (const label of labels.length > 1 ? labels.slice(0, -1) : labels) {
    const words = label.split('-').filter(Boolean);
    environment ??= words.find((word) => ENVIRONMENT.test(word)) ?? null;
    const meaningful = words.filter((word) => !ENVIRONMENT.test(word) && !GENERIC_HOST_PARTS.has(word) && !/^\d+$/.test(word));
    name ??= meaningful.length ? meaningful.join(' ') : null;
  }
  // Nothing but environment or generic parts (dev.to): the address's first part, as it is.
  if (!name) return labels[0] ? labels[0].charAt(0).toUpperCase() + labels[0].slice(1) : 'Site';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}${environment ? ` (${environment})` : ''}`;
}

// --- Duplicating a site (another copy of it: staging, training…) ---

const isGoogleHost = (host) => /(^|\.)google\.com$/.test(host);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A host typed or pasted as an address (https://app.example.com/login) or on its own.
export function hostFrom(text) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value) return '';
  try {
    return new URL(/^[a-z]+:\/\//.test(value) ? value : `https://${value}`).hostname;
  } catch {
    return '';
  }
}

// Every host a site entry uses, its own first: its host, its steps' hosts, its home page's, and
// those in its address patterns. Google's are left out: they're the same for every site.
export function siteHostsOf(entry) {
  const hosts = [];
  const add = (host) => {
    if (host && !isGoogleHost(host) && !hosts.includes(host)) hosts.push(host);
  };
  const hostOf = (address) => {
    if (/^https:\/\/[^/]*\*/.test(address)) return null; // a wildcard host
    try {
      return new URL(String(address).replace(/\*/g, 'x')).hostname;
    } catch {
      return null;
    }
  };
  add(entry.host);
  for (const step of entry.steps ?? []) add(step.host);
  if (entry.home) add(hostOf(entry.home));
  for (const pattern of [].concat(entry.matches ?? [], entry.reloadOnInstall ?? [])) add(hostOf(pattern));
  return hosts;
}

// The entry with hosts changed ({ old: new }) wherever they appear: its host, steps, home page,
// address patterns, Google check, and links inside its selectors. A host only matches whole, so
// changing acme.com doesn't touch login.acme.com.
export function withHosts(entry, changes) {
  const pairs = Object.entries(changes).filter(([from, to]) => from && to && from !== to);
  if (!pairs.length) return structuredClone(entry);
  const to = new Map(pairs.map(([from, host]) => [from.toLowerCase(), host]));
  const pattern = new RegExp(
    `(^|[^a-z0-9.-])(${[...to.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?=$|[^a-z0-9.-])`,
    'gi',
  );
  const walk = (value) => {
    if (typeof value === 'string') return value.replace(pattern, (_, before, host) => before + to.get(host.toLowerCase()));
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return walk(entry);
}

// A copy of a site entry for another copy of the site: no id (it gets its own when saved), its
// hosts changed, and its own name and labels.
export function duplicateEntry(entry, { hosts, label, labels }) {
  const { id: _id, label: _label, labels: _labels, ...rest } = entry;
  return { label, ...(labels?.length && { labels }), ...withHosts(rest, hosts) };
}

// Sites are enabled unless I disable one, so that list only keeps sites still in the config that I
// disabled myself: a site that's gone, or that was just added (recorded, duplicated, imported),
// isn't on it.
export function stillDisabled(disabledSites, siteIds, addedIds = []) {
  return (disabledSites ?? []).filter((id) => siteIds.includes(id) && !addedIds.includes(id));
}
