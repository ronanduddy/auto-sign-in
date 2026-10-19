// A recording: the steps I took on a site's own pages while signing in once, which become a
// "button" site with steps (see src/config/schema.js). The recorder (src/content/recorder.js)
// reports each click, email box and code box; background.js keeps the recording in
// chrome.storage.session and turns it into a config entry when I click Done. Nothing here
// touches chrome.*, so it can be unit tested. Nothing typed is ever recorded, only where.

export function startRecording({ tabId, label, url, now }) {
  const host = new URL(url).hostname;
  return {
    tabId,
    label,
    host,
    startUrl: url,
    // Hosts the recorder runs on. Others the tab visits need access first (see background.js).
    hosts: [host],
    steps: [],
    handover: [],
    google: { seen: false, mentioned: false, appName: null },
    startedAt: now,
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A click, or an email box and the click that sent it: { host, path, click, email?, fragile? }.
// The same step twice in a row (a double click, or a click and the form submit it caused) counts once.
export function recordStep(recording, { host, path, click, email, fragile = false }) {
  const step = { host, path, click, ...(email && { email }), ...(fragile && { fragile: true }), afterGoogle: recording.google.seen };
  const last = recording.steps.at(-1);
  if (last && last.host === host && last.path === path && same(last.click, click)) {
    // The submit that followed a click may know about the email box the click didn't.
    if (email && !last.email) return { ...recording, steps: [...recording.steps.slice(0, -1), { ...last, email }] };
    return recording;
  }
  return { ...recording, steps: [...recording.steps, step] };
}

// A password or code box on the site's own page: the run hands over to me there. Once per page.
export function recordHandover(recording, { path, selectors, kind }) {
  if (recording.handover.some((page) => page.path === path)) return recording;
  return { ...recording, handover: [...recording.handover, { path, selectors, kind }] };
}

// A Google sign-in page in the recording tab: whether its address names one of the site's hosts
// (the usual way a run tells its own Google sign-in apart), and the app name it shows.
export function noteGoogle(recording, { url, appName }) {
  const address = String(url).toLowerCase();
  const mentioned = recording.google.mentioned || recording.hosts.some((host) => address.includes(host));
  return { ...recording, google: { seen: true, mentioned, appName: recording.google.appName ?? (appName?.trim() || null) } };
}

export function addHost(recording, host) {
  return { ...recording, hosts: recording.hosts.includes(host) ? recording.hosts : [...recording.hosts, host], missedPages: false };
}

// The tab went on to a host the recorder can't see (no access yet), until addHost() covers one.
export function missedPages(recording) {
  return { ...recording, missedPages: true };
}

// The last thing recorded, for the bar and the popup.
export function lastRecorded(recording) {
  const step = recording.steps.at(-1);
  if (!step) return null;
  const what = step.click.texts?.[0] ? `"${step.click.texts[0]}"` : step.click.selectors[0];
  return step.email ? `your email, then ${what}` : what;
}

// The config entry (no id yet: the options page gives it one on saving) and notes for the
// review: steps found only by their position, steps after Google (probably just me using the
// site), and anything missing.
export function recordedSite(recording, { doneUrl }) {
  const { host } = recording;
  const steps = recording.steps.map((step) => ({
    ...(step.host !== host && { host: step.host }),
    path: step.path,
    ...(step.email && { email: step.email }),
    click: step.click,
  }));
  const entry = { type: 'button', label: recording.label, host };
  // Where I clicked Done is where the site is used once signed in: its home page, which may be on
  // another host (the app on its own domain). The root of the site's own host is the default anyway.
  try {
    const done = new URL(doneUrl);
    const isGoogle = done.hostname.endsWith('google.com');
    if (done.protocol === 'https:' && !isGoogle && (done.hostname !== host || done.pathname !== '/')) entry.home = `https://${done.hostname}${done.pathname}`;
  } catch {}
  entry.steps = steps;
  if (recording.handover.length) entry.handover = recording.handover.map(({ path, selectors }) => ({ path, selectors }));
  if (recording.google.seen && !recording.google.mentioned && recording.google.appName) {
    entry.google = { appNames: [recording.google.appName.toLowerCase()] };
  }

  const notes = {
    steps: recording.steps.map((step) => [step.fragile && 'found by its position on the page, so it may break', step.afterGoogle && 'after Google: probably not part of signing in'].filter(Boolean)),
    warnings: [],
  };
  if (!steps.length) notes.warnings.push('Nothing was clicked on the site, so there are no steps.');
  if (recording.missedPages) {
    notes.warnings.push('The sign-in went through a site the recorder couldn\'t see, so any steps there are missing. Record again, and on that site click the extension\'s icon and choose "Record on … too".');
  }
  if (!recording.google.seen) {
    notes.warnings.push(
      "The recorder didn't see Google's sign-in pages. That's normal if Google signed you straight in, as it can when you're already signed in to it. If the site doesn't sign in through Google at all, this extension can't sign in to it.",
    );
  }
  return { entry, notes };
}
