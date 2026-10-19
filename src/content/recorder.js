// The recorder's side of a page (see src/lib/recording.js). background.js runs it on the hosts of
// a site being recorded, in the recording tab only. It shows a bar, and reports what I do on the
// site's own pages while I sign in by hand:
//   - a click on a link or button: a click step (where the page is, and how to find it again);
//   - an email box: the recorder fills in my Google email from the options as soon as the box
//     shows (the extension only ever signs in with that account), and a click in the box's form
//     becomes "fill in your email, then click". A box I or my password manager filled counts too;
//   - a password or code box: the run hands over to me on that page.
// It only checks whether a box is empty, never what's in it, and never prevents or changes a
// click. Google's pages have no recorder: the extension already knows them.
(() => {
  if (globalThis.SAS_RECORDER_LOADED) return; // registered and injected into the same page
  globalThis.SAS_RECORDER_LOADED = true;
  const L = globalThis.SAS_LOCATE;
  const D = globalThis.SAS_DOM;

  let bar = null;
  let email = ''; // my Google email, from the options
  let pendingEmail = null; // the email box filled in last on this page, until its click
  const filledIn = new WeakSet(); // boxes the recorder filled in (once each: if I clear one, it's mine)
  let watcher = null;
  let lastStepAt = 0;

  function send(message) {
    if (!chrome.runtime?.id) return Promise.reject(new Error('the extension was reloaded'));
    return chrome.runtime.sendMessage(message);
  }

  const where = () => ({ host: location.hostname, path: L.stablePath(location.pathname) });

  // --- The bar ---

  function showBar(info) {
    const host = document.createElement('div');
    host.id = 'sas-recorder';
    Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647' });
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .bar { max-width: min(360px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 8px; background: #4a154b;
               color: #fff; font: 13px/1.45 system-ui, -apple-system, sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
        .title { font-weight: 600; }
        .title::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: #ff6b6b; }
        .said { margin: 4px 0 8px; opacity: .9; }
        button { margin-right: 6px; padding: 4px 10px; border-radius: 6px; font: 600 12px system-ui, sans-serif; cursor: pointer; }
        .done { background: #fff; color: #4a154b; border: 0; }
        .cancel { background: transparent; color: #fff; border: 1px solid #fff; }
      </style>
      <div class="bar" role="status">
        <div class="title"></div>
        <div class="said"></div>
        <button type="button" class="done" data-action="done">Done, I'm signed in</button>
        <button type="button" class="cancel" data-action="cancel">Cancel</button>
      </div>`;
    root.querySelector('.title').textContent = `Recording ${info.label}`;
    root.querySelector('[data-action="done"]').addEventListener('click', finish);
    root.querySelector('[data-action="cancel"]').addEventListener('click', cancel);
    document.documentElement.append(host);
    bar = host;
    say(info.count ? `${info.count} step${info.count === 1 ? '' : 's'} so far. Carry on signing in the way you normally do.` : 'Sign in the way you normally do. Each click on this site becomes a step.');
  }

  function say(text) {
    if (bar) bar.shadowRoot.querySelector('.said').textContent = text;
  }

  function stop(text) {
    for (const [type, fn] of LISTENERS) document.removeEventListener(type, fn, true);
    watcher?.disconnect();
    say(text);
    for (const button of bar?.shadowRoot.querySelectorAll('button') ?? []) button.remove();
    setTimeout(() => bar?.remove(), 4000);
  }

  async function finish() {
    await send({ type: 'recordingDone', url: location.href }).catch(() => {});
    stop('Recorded. Review the site in the options page, then save it.');
  }

  async function cancel() {
    await send({ type: 'recordingCancel' }).catch(() => {});
    stop('Recording cancelled.');
  }

  const inBar = (event) => bar && event.composedPath().includes(bar);

  // --- What I do on the page ---

  async function step(el) {
    const { fragile, ...click } = L.describeClick(el);
    const box = L.emailBoxFor(el, pendingEmail);
    const field = box ? L.describeField(box) : null;
    pendingEmail = null;
    lastStepAt = Date.now();
    const reply = await send({
      type: 'recordStep',
      ...where(),
      click,
      ...(field && { email: { selectors: field.selectors } }),
      fragile: Boolean(fragile || field?.fragile),
    }).catch(() => null);
    if (reply) say(`Step ${reply.count}: ${reply.last}.`);
  }

  function onClick(event) {
    if (!event.isTrusted || inBar(event)) return;
    const el = L.clickableFor(event.target);
    if (el) step(el);
  }

  // Pressing Enter in a form submits it without a click of mine: its submit button is the step.
  function onSubmit(event) {
    if (Date.now() - lastStepAt < 1000) return;
    const button = event.submitter ?? event.target.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    if (button) step(button);
  }

  // Typing in an email box, or a password manager filling it in.
  function onInput(event) {
    if (inBar(event)) return;
    const box = event.target;
    if (!L.isEmailField(box) || pendingEmail === box) return;
    pendingEmail = box;
    say('This box will get your Google email each time, then the button you click next.');
  }

  // Email boxes get my Google email as soon as they show, so there's nothing to type.
  function fillEmailBoxes() {
    if (!email) return;
    for (const box of L.emptyEmailBoxes()) {
      if (filledIn.has(box)) continue;
      filledIn.add(box);
      D.setValue(box, email);
      pendingEmail = box;
      say('Filled in your Google email. Each sign-in will do the same, then click the button you click next.');
    }
  }

  let fillScheduled = false;
  function scheduleFill() {
    if (fillScheduled) return;
    fillScheduled = true;
    setTimeout(() => {
      fillScheduled = false;
      fillEmailBoxes();
    }, 300);
  }

  function onFocus(event) {
    if (!event.isTrusted || inBar(event)) return;
    const box = event.target;
    const kind = L.isPasswordField(box) ? 'password' : L.isCodeField(box) ? 'code' : null;
    if (!kind) return;
    const { selectors } = L.describeField(box);
    send({ type: 'recordHandover', path: L.stablePath(location.pathname), selectors, kind })
      .then(() => say(`The extension will hand over to you at this ${kind === 'password' ? 'password' : 'code'} box. Type it as usual.`))
      .catch(() => {});
  }

  const LISTENERS = [
    ['click', onClick],
    ['submit', onSubmit],
    ['input', onInput],
    ['focusin', onFocus],
  ];

  send({ type: 'recorderHello' })
    .then((info) => {
      if (!info?.recording) return;
      showBar(info);
      for (const [type, fn] of LISTENERS) document.addEventListener(type, fn, true);
      email = info.email ?? '';
      fillEmailBoxes();
      // Sign-in pages often show the email box later, without a page load.
      watcher = new MutationObserver(scheduleFill);
      watcher.observe(document.documentElement, { childList: true, subtree: true });
    })
    .catch(() => {});
})();
