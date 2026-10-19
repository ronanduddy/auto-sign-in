// The options page's site list and editor. Each site gets a row: Enable or Disable, Edit,
// Duplicate and Remove. Every site is enabled unless it's switched off here (disabledSites in the
// settings) or its host access is missing; disabling one also gives its access back. "Record a site" makes a site by
// watching me sign in once (src/lib/recording.js), then opens it here for review as a list of its
// steps; a site the list can't show in full opens as JSON. The two built-ins are different: Google
// itself only has its on/off box, and Slack is set up in its own section of the page. Any other
// site can be duplicated for another copy of it (staging, say), changing only its addresses and
// name. Adding, editing and removing save the config straight away.

import { DEFAULT_SETTINGS } from '../lib/config.js';
import { CONFIG_VERSION, parseConfig } from '../config/schema.js';
import { saveConfig } from '../config/store.js';
import { buildRegistry } from '../sites/build.js';
import {
  FIELDS,
  describeHandover,
  describeStep,
  duplicateEntry,
  hostFrom,
  nameFromAddress,
  siteHostsOf,
  stepsEditable,
  stillDisabled,
  uniqueId,
} from './site-form.js';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const smallButton = (text, onClick, className = 'secondary small') => {
  const button = el('button', { type: 'button', className, textContent: text });
  button.addEventListener('click', onClick);
  return button;
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A selector the browser can't parse would make that site fail later; catch it before saving.
export function badSelectors(config) {
  const problems = [];
  for (const site of buildRegistry(config).sites) {
    for (const [name, element] of Object.entries(site.elements)) {
      for (const selector of element.selectors ?? []) {
        try {
          document.createDocumentFragment().querySelector(selector);
        } catch {
          problems.push(`${site.label}: "${selector}" (${name}) isn't a valid CSS selector.`);
        }
      }
    }
  }
  return problems;
}

// The config document (`raw`, as stored: preset entries and all) is the editor's to change.
// onChange(raw) runs after every save, for the parts of the page that depend on the sites.
export function setUpSitesEditor({ raw: initial, onChange }) {
  let raw = initial;
  let editing = null; // { index (null when adding), mode: 'steps' | 'json' | 'duplicate', review, draft, notes, source, hosts }

  const parsed = () => parseConfig(raw).config;
  // Each entry's id, by its position in the document (an entry can leave a preset's id implied).
  const entryIds = () => raw.sites.map((entry) => parseConfig({ version: CONFIG_VERSION, sites: [entry] }).config.sites[0]?.id);

  // Saves a new config document, then gives back host access that no site needs any more. Sites
  // added here (added: their ids) start enabled, and a removed site leaves the disabled list.
  async function commit(next, { added = [] } = {}) {
    const before = buildRegistry(parsed());
    const after = buildRegistry(parseConfig(next).config);
    await saveConfig(next);
    const { settings } = await chrome.storage.local.get('settings');
    const disabledSites = stillDisabled(settings?.disabledSites, after.sites.map((site) => site.id), added);
    if (disabledSites.length !== (settings?.disabledSites ?? []).length) {
      await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings, disabledSites } });
    }
    const needed = new Set(after.sites.flatMap((site) => after.accessFor(site)));
    const unused = [...new Set(before.sites.flatMap((site) => before.accessFor(site)))].filter((origin) => !needed.has(origin));
    // Access the manifest grants can't be removed (the test build grants every site), hence the catch.
    if (unused.length) await chrome.permissions.remove({ origins: unused }).catch(() => false);
    raw = next;
    renderList();
    onChange(raw);
  }

  function say(text) {
    $('sites-status').textContent = text;
  }

  // --- The list ---

  function renderList() {
    const sites = buildRegistry(parsed());
    const ids = entryIds();
    const switchedOff = disabledIds();
    const states = []; // each site's disabled-or-not, for the count
    $('sites').replaceChildren(
      ...sites.byLabel().map((site) => {
        const index = ids.indexOf(site.id);
        // The host links to the site in a new tab.
        const link = el('a', { className: 'hint', href: site.home, target: '_blank', rel: 'noopener noreferrer', textContent: new URL(site.home).host });
        const text = el('span', { className: 'site-name' }, `${site.label} `, link);
        for (const tag of site.labels ?? []) text.append(el('span', { className: 'note', textContent: tag }));
        const status = el('span', { className: 'note', textContent: 'disabled', hidden: true });
        text.append(status);
        const actions = el('span', { className: 'row-actions' });
        const row = el('div', { className: 'site-row' }, text, actions);
        row.dataset.site = site.id;
        let toggle = [];
        // Google itself is built in: it can only be disabled. Slack is set up in its own section.
        const edit = site.workspace ? () => goToSlack() : () => openEditor({ index });
        const showActions = () =>
          actions.replaceChildren(
            ...toggle,
            ...(site.googleItself
              ? []
              : [
                  smallButton('Edit', edit),
                  ...(site.workspace ? [] : [smallButton('Duplicate', () => openDuplicate(index))]),
                  smallButton('Remove', () => confirmRemove(site, index, actions, showActions)),
                ]),
          );
        showActions();
        // Disabled when switched off here, or when its host access is missing (refused, or removed).
        const state = Promise.all([switchedOff, missingAccess(sites, site)]).then(([off, missing]) => {
          const disabled = off.has(site.id) || Boolean(missing);
          status.hidden = !disabled;
          toggle = [disabled ? smallButton('Enable', () => enable(sites, site)) : smallButton('Disable', () => disable(sites, site))];
          if (!actions.querySelector('.danger')) showActions();
          return disabled;
        });
        states.push(state);
        return row;
      }),
    );
    // How many sites there are, beside the heading, and how many of them are disabled.
    Promise.all(states).then((disabled) => {
      const off = disabled.filter(Boolean).length;
      $('sites-count').textContent = `${disabled.length} site${disabled.length === 1 ? '' : 's'}${off ? `, ${off} disabled` : ''}`;
    });
  }

  function goToSlack() {
    $('slack-settings').scrollIntoView({ block: 'start' });
    $('slackWorkspace').focus();
  }

  // The sites switched off here (the settings' disabledSites).
  async function disabledIds() {
    const { settings } = await chrome.storage.local.get('settings');
    return new Set(settings?.disabledSites ?? []);
  }

  async function setDisabled(id, off) {
    const { settings } = await chrome.storage.local.get('settings');
    const ids = new Set(settings?.disabledSites ?? []);
    if (off) ids.add(id);
    else ids.delete(id);
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings, disabledSites: [...ids] } });
  }

  // Enable: ask for the site's access in this click (a permission prompt needs one), then switch it
  // back on. Google itself needs no access of its own.
  function enable(sites, site) {
    const access = sites.accessFor(site);
    const asked = access.length ? chrome.permissions.request({ origins: access }).catch(() => false) : Promise.resolve(true);
    asked.then(async (granted) => {
      if (!granted) return say(`${site.label} stays disabled: Chrome didn't give the extension access to it.`);
      await setDisabled(site.id, false);
      renderList();
      say(`Enabled ${site.label}.`);
    });
  }

  // Disable: switch it off, and give back its access unless another enabled site uses the same
  // addresses. (Access the manifest grants can't be given back, hence the catch.)
  async function disable(sites, site) {
    await setDisabled(site.id, true);
    const off = await disabledIds();
    const stillUsed = new Set(sites.sites.filter((other) => !off.has(other.id)).flatMap((other) => sites.accessFor(other)));
    const giveBack = sites.accessFor(site).filter((origin) => !stillUsed.has(origin));
    if (giveBack.length) await chrome.permissions.remove({ origins: giveBack }).catch(() => false);
    renderList();
    say(`Disabled ${site.label}.`);
  }

  // The host access a site needs but doesn't have, or null.
  async function missingAccess(sites, site) {
    const access = sites.accessFor(site);
    if (!access.length || (await chrome.permissions.contains({ origins: access }))) return null;
    return access;
  }

  function confirmRemove(site, index, actions, cancel) {
    const remove = smallButton(
      'Remove',
      async () => {
        await commit({ ...raw, sites: raw.sites.filter((_, i) => i !== index) });
        say(`Removed ${site.label}.`);
      },
      'danger small',
    );
    actions.replaceChildren(el('span', { className: 'hint', textContent: `Remove ${site.label}?` }), remove, smallButton('Keep', cancel));
    remove.focus();
  }

  // --- The editor ---

  // index: the entry's position, or null for a recording (given as entry, with its notes), which
  // is cleared from the session once saved or dropped.
  function openEditor({ index, entry: given, notes, review = false }) {
    const entry = given ?? raw.sites[index];
    const label = index === null ? null : buildRegistry(parsed()).byId(entryIds()[index])?.label;
    const mode = stepsEditable(entry) ? 'steps' : 'json';
    editing = { index, mode, review };
    $('editor-title').textContent = review ? `Review the recording: ${entry.label}` : `Edit ${label ?? 'site'}`;
    if (mode === 'steps') showSteps(entry, notes);
    else showJson(entry, "This site has settings the list of steps can't show, so here it is as JSON.");
    $('editor-problems').hidden = true;
    $('site-editor').hidden = false;
    say('');
    $('site-editor').scrollIntoView({ block: 'nearest' });
    $('site-editor').querySelector('input, textarea')?.focus();
  }

  const field = (name, spec, value) => {
    const id = `site-field-${name}`;
    const input = el('input', { id, type: 'text', value: value ?? '', placeholder: spec.placeholder ?? '', spellcheck: false, autocomplete: 'off' });
    input.dataset.field = name;
    input.required = Boolean(spec.required);
    return el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: spec.title }), input, ...(spec.hint ? [el('p', { className: 'hint', textContent: spec.hint })] : []));
  };

  // A copy of a site for another copy of it (staging, training…): its name, each address it uses
  // (the steps, home page and Google check follow them), and its labels. The name follows the
  // first address until you type one.
  function openDuplicate(index) {
    const source = raw.sites[index];
    const hosts = siteHostsOf(source);
    const label = buildRegistry(parsed()).byId(entryIds()[index])?.label ?? source.label ?? 'site';
    editing = { index: null, mode: 'duplicate', source, hosts, nameEdited: false };
    $('editor-title').textContent = `Duplicate ${label}`;
    $('editor-fields').replaceChildren(
      field('label', FIELDS.label, label),
      ...hosts.map((host, i) =>
        field(
          `host${i}`,
          i === 0
            ? { title: 'Address', required: true, hint: "The other copy's address. Its steps, home page and Google check follow it." }
            : { title: 'Also signs in through', required: true, hint: 'Change it too if the other copy signs in through its own address.' },
          host,
        ),
      ),
      field('labels', FIELDS.labels, (source.labels ?? []).join(', ')),
    );
    const name = $('editor-fields').querySelector('[data-field="label"]');
    name.addEventListener('input', () => {
      editing.nameEdited = true;
    });
    $('editor-fields')
      .querySelector('[data-field="host0"]')
      .addEventListener('input', (event) => {
        const host = hostFrom(event.target.value);
        if (!editing.nameEdited && host) name.value = nameFromAddress(`https://${host}/`);
      });
    $('editor-fields').hidden = false;
    $('editor-steps').hidden = true;
    $('editor-json-field').hidden = true;
    $('editor-as-json').hidden = false;
    $('editor-problems').hidden = true;
    $('site-editor').hidden = false;
    say('');
    $('site-editor').scrollIntoView({ block: 'nearest' });
    $('editor-fields').querySelector('[data-field="host0"]').focus();
  }

  const splitLabels = (text) =>
    String(text ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

  // The duplicate the form describes, or what's missing.
  function duplicateFromForm(values) {
    const label = String(values.label ?? '').trim();
    const problems = label ? [] : ['Fill in "Name".'];
    const hosts = {};
    editing.hosts.forEach((host, i) => {
      const next = hostFrom(values[`host${i}`]);
      if (next) hosts[host] = next;
      else problems.push(`Fill in the address that replaces ${host}.`);
    });
    if (problems.length) return { problems };
    const entry = duplicateEntry(editing.source, { hosts, label, labels: splitLabels(values.labels) });
    return { entry: { id: uniqueId(label, new Set(entryIds())), ...entry } };
  }

  // A site with steps: its name and labels, then each step and verification page, each removable.
  function showSteps(entry, notes = {}) {
    editing.draft = structuredClone(entry);
    editing.notes = notes;
    $('editor-fields').replaceChildren(
      field('label', FIELDS.label, entry.label),
      field('labels', FIELDS.labels, (entry.labels ?? []).join(', ')),
    );
    renderStepList();
    $('editor-fields').hidden = false;
    $('editor-steps').hidden = false;
    $('editor-json-field').hidden = true;
    $('editor-as-json').hidden = false;
  }

  function renderStepList() {
    const { draft, notes } = editing;
    const item = (text, remarks, onRemove) =>
      el('li', {}, el('span', { textContent: text }), ...remarks.map((remark) => el('span', { className: 'note', textContent: remark })), ' ', smallButton('Remove', onRemove));
    $('editor-step-list').replaceChildren(
      ...draft.steps.map((step, i) =>
        item(describeStep(step, draft.host), notes.steps?.[i] ?? [], () => {
          draft.steps.splice(i, 1);
          notes.steps?.splice(i, 1);
          renderStepList();
        }),
      ),
    );
    $('editor-handover-list').replaceChildren(
      ...(draft.handover ?? []).map((page, i) =>
        item(describeHandover(page), [], () => {
          draft.handover.splice(i, 1);
          if (!draft.handover.length) delete draft.handover;
          renderStepList();
        }),
      ),
    );
    $('editor-handover-heading').hidden = !draft.handover?.length;
    $('editor-warnings').replaceChildren(...(notes.warnings ?? []).map((text) => el('p', { className: 'warning', textContent: text })));
  }

  function showJson(entry, why) {
    $('editor-json').value = JSON.stringify(entry, null, 2);
    $('editor-json').setSelectionRange(0, 0);
    $('editor-json').scrollTop = 0;
    $('editor-json-why').textContent = why ?? '';
    $('editor-json-why').hidden = !why;
    $('editor-fields').hidden = true;
    $('editor-steps').hidden = true;
    $('editor-json-field').hidden = false;
    $('editor-as-json').hidden = true;
    editing.mode = 'json';
  }

  const formInput = () => Object.fromEntries([...$('editor-fields').querySelectorAll('input')].map((input) => [input.dataset.field, input.value]));

  // The id the entry keeps: an existing entry's own (possibly implied), or a new one from its name.
  function idFor(values) {
    if (editing.index !== null) return raw.sites[editing.index].id;
    return uniqueId(values.label.trim(), new Set(entryIds()));
  }

  // A site with steps, from the list and its name and labels.
  function entryFromSteps(values) {
    const { draft } = editing;
    const labels = splitLabels(values.labels);
    const { id: _id, label: _label, labels: _labels, ...rest } = draft;
    const id = idFor(values);
    return { ...(id !== undefined && { id }), label: values.label.trim(), ...(labels.length && { labels }), ...rest };
  }

  // The site entry the editor holds, or the problems stopping it.
  function draft() {
    if (editing.mode === 'json') {
      try {
        const entry = JSON.parse($('editor-json').value);
        return isObject(entry) ? { entry } : { problems: ['The site needs to be a JSON object: { … }.'] };
      } catch (error) {
        return { problems: [`That isn't valid JSON (${error.message}).`] };
      }
    }
    const values = formInput();
    if (editing.mode === 'duplicate') return duplicateFromForm(values);
    if (!values.label.trim()) return { problems: ['Fill in "Name".'] };
    if (!editing.draft.steps.length) return { problems: ['A site needs at least one step.'] };
    return { entry: entryFromSteps(values) };
  }

  function showProblems(problems) {
    $('editor-problems').replaceChildren(...problems.map((text) => el('li', { textContent: text })));
    $('editor-problems').hidden = false;
  }

  $('editor-as-json').addEventListener('click', () => {
    if (editing.mode === 'duplicate') {
      const { entry, problems } = duplicateFromForm(formInput());
      if (problems) return showProblems(problems);
      showJson(entry);
    } else {
      showJson(entryFromSteps(formInput()));
    }
    $('editor-json').focus();
  });

  function save() {
    const { entry, problems } = draft();
    if (problems) return showProblems(problems);
    const index = editing.index ?? raw.sites.length;
    const sites = [...raw.sites];
    sites[index] = entry;
    const next = { ...raw, sites };
    const { config, errors } = parseConfig(next);
    const invalid = errors.length ? errors : badSelectors(config);
    if (invalid.length) return showProblems(invalid);

    // Ask for the site's access in this click (a permission prompt needs one). Saying no still
    // saves the site; it then shows as disabled, with Enable, until you allow it.
    const registry = buildRegistry(config);
    const site = registry.byId(config.sites[index].id);
    const access = registry.accessFor(site);
    const asked = access.length ? chrome.permissions.request({ origins: access }).catch(() => false) : Promise.resolve(true);
    return asked.then(async () => {
      await commit(next, { added: editing.index === null ? [site.id] : [] });
      closeEditor();
      say(`Saved ${site.label}.`);
    });
  }

  function closeEditor() {
    if (editing?.review) chrome.storage.session.remove('recorded');
    editing = null;
    $('site-editor').hidden = true;
  }

  $('editor-save').addEventListener('click', save);
  $('editor-cancel').addEventListener('click', closeEditor);
  // Enter in a field saves the site, not the whole page's form around it.
  $('site-editor').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      save();
    }
  });

  // --- Recording a site ---

  function showRecordProblems(problems) {
    $('record-problems').replaceChildren(...problems.map((text) => el('li', { textContent: text })));
    $('record-problems').hidden = !problems.length;
  }

  function openRecordForm(url = '') {
    $('record-form').hidden = false;
    showRecordProblems([]);
    if (url) $('record-url').value = url;
    $('record-form').scrollIntoView({ block: 'nearest' });
    $('record-url').focus();
  }
  $('record-site').addEventListener('click', () => openRecordForm());

  // The popup's "Record a site" opens this page with the form ready (and the tab's address).
  async function recordRequested() {
    const { recordRequest } = await chrome.storage.session.get('recordRequest');
    if (!recordRequest) return;
    await chrome.storage.session.remove('recordRequest');
    openRecordForm(recordRequest.url);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.recordRequest?.newValue) recordRequested();
  });
  recordRequested();
  $('record-cancel').addEventListener('click', () => {
    $('record-form').hidden = true;
  });

  // The address's https origin, or null.
  function siteAddress(text) {
    try {
      const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
      return url.protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  }

  function startRecording() {
    const url = siteAddress($('record-url').value.trim());
    if (!url) return showRecordProblems(['The address needs to be an https:// address, such as https://app.example.com/.']);
    showRecordProblems([]);
    // No name given: one from the address, which the review lets you change.
    const label = $('record-label').value.trim() || nameFromAddress(url.href);
    // The recorder needs access to the site's host, or (to follow the sign-in wherever it goes) to
    // every site until the recording ends; this click is what lets Chrome ask.
    const follow = $('record-follow').checked;
    chrome.permissions
      .request({ origins: [follow ? 'https://*/*' : `${url.origin}/*`] })
      .catch(() => false)
      .then(async (granted) => {
        if (!granted) {
          return showRecordProblems([
            follow
              ? 'Recording needs that access to follow the sign-in. Untick "Follow the sign-in to other sites" to record with access to this site only.'
              : `Recording needs access to ${url.host}.`,
          ]);
        }
        await chrome.runtime.sendMessage({ type: 'startRecording', url: url.href, label, follow });
        $('record-form').hidden = true;
        say(`Recording ${label} in a new tab. Sign in there the way you normally do, then click Done in the bar.`);
      });
  }

  $('record-start').addEventListener('click', startRecording);
  $('record-form').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      startRecording();
    }
  });

  // A finished recording (background.js keeps it in the session) opens here for review.
  async function reviewRecording() {
    const { recorded } = await chrome.storage.session.get('recorded');
    if (!recorded || editing?.review) return;
    say('');
    openEditor({ index: null, entry: recorded.entry, notes: recorded.notes, review: true });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.recorded?.newValue) reviewRecording();
  });
  reviewRecording();

  renderList();
  return {
    config: () => raw,
    commit,
  };
}
