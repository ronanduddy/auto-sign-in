// Runs on every site's pages (src/sites/) and on Google's sign-in pages. It knows nothing
// about any particular site: it asks the background worker which elements to look for here,
// reports which are on the page, gets back one action (see engine.js) and carries it out.
// It re-checks when the DOM changes, because Google and some sites move between steps
// without full page loads. Google's selectors come from selectors.js, helpers from dom.js.
(() => {
  const SEL = globalThis.SAS_SELECTORS;
  const D = globalThis.SAS_DOM;
  const STEP_TIMEOUT_MS = 10_000;
  const SETTLE_MS = 3000; // a page counts as settled once its URL hasn't changed for this long

  const onGoogle = location.hostname === 'accounts.google.com';
  let siteElements = {}; // this site's elements, from its definition (sent by the background worker)

  function elementSpec(name) {
    return siteElements[name] ?? SEL.google.elements[name];
  }

  function applies(spec) {
    return (!spec.hosts || spec.hosts.includes(location.hostname)) && (!spec.path || location.pathname.startsWith(spec.path));
  }

  function findElement(name) {
    const spec = elementSpec(name);
    if (!spec || !applies(spec)) return null;
    return (spec.selectors && D.first(spec.selectors)) || (spec.texts && D.buttonWithText(SEL.clickables, spec.texts)) || null;
  }

  // Which of this site's elements are on the page.
  function found() {
    const present = {};
    for (const name of Object.keys(siteElements)) {
      if (findElement(name)) present[name] = true;
    }
    return present;
  }

  function markers() {
    if (!onGoogle) return {};
    return {
      googlePassword: Boolean(findElement('googlePassword')),
      googleEmailInput: Boolean(findElement('googleEmail')),
      googleVerify: D.pageHasText(SEL.google.verifyHeading),
      continueTo: D.pageTextMatch(SEL.google.continueTo),
      consentApp: SEL.google.consentApp.map((pattern) => D.pageTextMatch(pattern)).find(Boolean) ?? null,
    };
  }

  // Settling: how long the URL has stayed the same (sites use this to spot signed-in pages).
  let lastHref = location.href;
  let urlSince = performance.now();
  let settleCheckFor = null;

  function settled() {
    if (onGoogle) return false;
    if (location.href !== lastHref) {
      lastHref = location.href;
      urlSince = performance.now();
    }
    const waited = performance.now() - urlSince;
    if (waited >= SETTLE_MS) return true;
    if (settleCheckFor !== location.href) {
      settleCheckFor = location.href;
      setTimeout(schedule, SETTLE_MS - waited + 50);
    }
    return false;
  }

  // Identifies the page this script has already handled. continueTo is left out because it's
  // evidence about a page, not a different page. So is settling once any of the site's elements
  // is showing: settling only tells signed-in pages apart, and a sign-in page reported again
  // after 3 seconds would look like a new attempt (and click again).
  function pageKey(present, m, isSettled) {
    const elements = Object.keys(present).sort();
    const google = ['googlePassword', 'googleEmailInput', 'googleVerify'].filter((k) => m[k]);
    const settledPart = isSettled && elements.length === 0 ? 'settled' : '';
    return [location.href, elements.join(','), google.join(','), settledPart].join('|');
  }

  let ready = false;
  let handledKey = null;
  let waitingForVisible = false;
  let pausedUntil = 0;
  let busy = false;
  let recheck = false;

  async function check() {
    if (!ready) return;
    if (busy) {
      recheck = true;
      return;
    }
    if (waitingForVisible && document.visibilityState !== 'visible') return;
    if (Date.now() < pausedUntil) return;

    const present = found();
    const m = markers();
    const isSettled = settled();
    const key = pageKey(present, m, isSettled);
    if (key === handledKey) return;

    busy = true;
    try {
      const action = await send({
        type: 'page',
        signals: {
          url: location.href,
          visible: document.visibilityState === 'visible',
          pageAgeMs: Math.round(performance.now()),
          found: present,
          markers: m,
          settled: isSettled,
        },
      });
      if (action?.banner) D.banner(action.banner.text, action.banner);
      if (action?.do === 'waitVisible') {
        waitingForVisible = true; // visibilitychange calls check() again
        return;
      }
      if (action?.do === 'retryLater') {
        // Paused by the loop guard, or another tab is signing in. The page isn't marked as
        // handled, so it asks again then (or, if the tab is hidden then, when I come back to it).
        pausedUntil = Date.now() + action.afterMs;
        setTimeout(schedule, action.afterMs + 500);
        return;
      }
      waitingForVisible = false;
      handledKey = key;
      if (action && action.do !== 'noop') await perform(action);
    } catch (error) {
      handledKey = key;
      send({ type: 'error', message: error.message }).catch(() => {});
    } finally {
      busy = false;
      if (recheck) {
        recheck = false;
        schedule();
      }
    }
  }

  async function perform(action) {
    switch (action.do) {
      case 'navigate':
        return execute(action, null, `go to ${action.url}`, () => location.replace(action.url));
      case 'reload':
        return execute(action, null, 'reload this page because it has been open a while', () => location.reload());
      case 'click': {
        const el = await waitForElement(action.element);
        return execute(action, el, `click ${label(action.element)}`, () => D.press(el));
      }
      case 'recordingBanner':
        // A recording is going on in this tab: Google's pages are left to me, and this says so.
        D.banner(action.text);
        return undefined;
      case 'fillEmail': {
        // A site's email step: your Google email from the settings, then its button. Only ever
        // that, and never into a password box.
        const input = await waitForElement(action.field);
        if (input.type === 'password') throw new Error(`${label(action.field)} is a password box`);
        const description = `enter ${action.email} in ${label(action.field)} and click ${label(action.element)}`;
        return execute(action, input, description, async () => {
          D.setValue(input, action.email);
          D.press(await waitForElement(action.element));
        });
      }
      case 'focus': {
        const el = await waitForElement(action.element);
        return execute(action, el, `focus ${label(action.element)}`, () => el.focus());
      }
      case 'awaitPassword': {
        const input = await waitForElement('googlePassword');
        const description = action.submitWhenFilled
          ? `focus ${label('googlePassword')}, then click Next once your password manager fills it in`
          : `focus ${label('googlePassword')}`;
        return execute(action, input, description, () => {
          input.focus();
          if (action.submitWhenFilled) D.onAutofilled(input, () => submitPassword(input));
        });
      }
      case 'awaitCode': {
        // Some 2-Step pages have no code box (e.g. "Check your phone"): those are simply mine.
        const input = await D.waitFor(() => findElement('googleCode'), STEP_TIMEOUT_MS).catch(() => null);
        if (!input) return;
        const remember = action.assist ? D.checkboxLabelled(SEL.google.rememberDeviceLabel) : null;
        const longCode = SEL.google.longCodePaths.some((path) => location.pathname.startsWith(path));
        const description = action.assist
          ? `tick "Don't ask again on this device", focus ${label('googleCode')}, then click Next once the code is in`
          : `focus ${label('googleCode')}`;
        return execute(action, remember ?? input, description, () => {
          if (remember && !D.isChecked(remember)) D.press(remember);
          input.focus();
          if (action.assist && !longCode) D.onCodeComplete(input, () => submitCode(input));
        });
      }
      case 'clickAccount': {
        const row = await waitFor(
          () => D.accountRow(action.email, SEL.google.accountRowClickable),
          `the ${action.email} account`,
        );
        return execute(action, row, `choose ${action.email}`, () => D.press(row));
      }
      case 'confirmAccount': {
        if (!D.pageHasText(action.email)) throw new Error(`the account shown isn't ${action.email}`);
        const next = await waitForElement('googleNext');
        return execute(action, next, 'click Next', () => D.press(next));
      }
      case 'enterEmail': {
        const input = await waitForElement('googleEmail');
        const next = await waitForElement('googleNext');
        return execute(action, input, `enter ${action.email} and click Next`, () => {
          D.setValue(input, action.email);
          D.press(next);
        });
      }
      default:
        throw new Error(`unknown action "${action.do}"`);
    }
  }

  // Called once per password page (onAutofilled stops watching after a fill), so a wrong
  // password can't be resubmitted in a loop.
  async function submitPassword(input) {
    if (!input.isConnected || input.value.length === 0) return;
    try {
      D.press(await waitForElement('googleNext'));
    } catch (error) {
      send({ type: 'error', message: error.message }).catch(() => {});
    }
  }

  // Once per 2-Step page, like the password: a wrong code can't be resubmitted in a loop.
  async function submitCode(input) {
    if (!input.isConnected) return;
    try {
      D.press(await waitForElement('googleNext'));
    } catch (error) {
      send({ type: 'error', message: error.message }).catch(() => {});
    }
  }

  function label(name) {
    return elementSpec(name)?.label ?? name;
  }

  function waitForElement(name) {
    return waitFor(() => findElement(name), label(name));
  }

  async function waitFor(find, description) {
    try {
      return await D.waitFor(find, STEP_TIMEOUT_MS);
    } catch {
      throw new Error(`couldn't find ${description}`);
    }
  }

  function execute(action, el, description, fn) {
    if (!action.dryRun) return fn();
    if (el) D.highlight(el);
    D.banner(`Auto sign-in (dry run): would ${description}`);
  }

  function send(message) {
    // Pages left open across an extension reload lose their connection to it.
    if (!chrome.runtime?.id) return Promise.reject(new Error('the extension was reloaded'));
    return chrome.runtime.sendMessage(message);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      check();
    }, 300);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
  });
  window.addEventListener('pageshow', (event) => {
    // Restored from the back/forward cache: treat it as a fresh visit.
    if (event.persisted) {
      handledKey = null;
      schedule();
    }
  });

  function start() {
    ready = true;
    schedule();
  }

  if (onGoogle) {
    // Leaving a Google sign-in page is how the Google loop sees that Google has sent the tab
    // on, signed in (see engine.js, googleLeft).
    window.addEventListener('pagehide', () => {
      if (handledKey) send({ type: 'leftGoogle' }).catch(() => {});
    });
    // Give Google's page a moment to render before judging what it is.
    D.waitFor(() => document.querySelector(SEL.google.rendered), 5000).catch(() => {}).finally(start);
  } else {
    send({ type: 'elements', url: location.href })
      .then((elements) => {
        siteElements = elements ?? {};
      })
      .catch(() => {})
      .finally(start);
  }
})();
