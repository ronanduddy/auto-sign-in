// DOM helpers for the content script. They take selectors as arguments rather than
// reading selectors.js, so test/dom.test.js can run them against fixture HTML.
globalThis.SAS_DOM = (() => {
  const normalise = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (!el?.isConnected || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // The first visible element matching any of the selectors, tried in order.
  function first(selectors, root = document) {
    for (const selector of [].concat(selectors)) {
      for (const el of root.querySelectorAll(selector)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  // The first visible, enabled clickable whose whole text is one of texts (ignoring case),
  // trying the texts in order.
  function buttonWithText(clickableSelector, texts) {
    const candidates = [...document.querySelectorAll(clickableSelector)].filter(
      (el) => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    );
    for (const text of [].concat(texts)) {
      const want = normalise(text).toLowerCase();
      const match = candidates.find((el) => normalise(el.textContent).toLowerCase() === want);
      if (match) return match;
    }
    return null;
  }

  // Google's account row for this email: the element carrying it as a data attribute if
  // Google still sets one, otherwise the nearest clickable ancestor of the text showing it.
  function accountRow(email, clickableSelector) {
    const want = normalise(email).toLowerCase();
    if (!want) return null;
    for (const el of document.querySelectorAll('[data-identifier], [data-email]')) {
      const value = (el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').toLowerCase();
      if (value === want && isVisible(el)) return el;
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (normalise(walker.currentNode.nodeValue).toLowerCase() !== want) continue;
      const row = walker.currentNode.parentElement?.closest(clickableSelector);
      if (row && isVisible(row)) return row;
    }
    return null;
  }

  // pattern is a RegExp or a case-insensitive substring.
  function pageHasText(pattern) {
    const text = document.body?.innerText ?? '';
    return typeof pattern === 'string' ? text.toLowerCase().includes(pattern.toLowerCase()) : pattern.test(text);
  }

  // The first capture group of pattern in the page's text, or null.
  function pageTextMatch(pattern) {
    return pattern.exec(document.body?.innerText ?? '')?.[1]?.trim() ?? null;
  }

  // Resolves with find()'s first truthy result, re-checking whenever the DOM changes.
  function waitFor(find, timeoutMs) {
    return new Promise((resolve, reject) => {
      const found = find();
      if (found) {
        resolve(found);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = find();
        if (el) {
          stop();
          resolve(el);
        }
      });
      const timer = setTimeout(() => {
        stop();
        reject(new Error('timed out'));
      }, timeoutMs);
      function stop() {
        observer.disconnect();
        clearTimeout(timer);
      }
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  // A full pointer/mouse sequence, for widgets that listen for mousedown rather than click.
  function press(el) {
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', at));
    el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.click();
  }

  // Sets an input's value so that frameworks tracking it (React included) see the change.
  function setValue(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Calls onFill once a password manager (or a paste) has filled the input and it has then
  // stayed unchanged for settleMs. It looks only at the value's length and at the events'
  // timing and isTrusted flag, never at the value itself. Any of these counts as a fill:
  //   - an untrusted input event that changed the value (a script, such as a password
  //     manager simulating typing);
  //   - more than one character added in one change (an autofill or a paste);
  //   - a change with no input event at all (caught by polling);
  //   - BURST_CHARS or more characters, each under BURST_GAP_MS after the last.
  // A person typing produces trusted events, one character at a time and far slower, so a
  // typed password never counts, and typing over a fill hands the box back to the person.
  // Returns a function that stops watching. isTrusted is overridable for tests.
  const BURST_CHARS = 6;
  const BURST_GAP_MS = 30;

  function onAutofilled(input, onFill, { settleMs = 400, pollMs = 250, isTrusted = (event) => event.isTrusted } = {}) {
    let lastLength = input.value.length;
    let lastChangeAt = 0;
    let burst = 0;
    let settle = null;
    // Already filled before watching started (a manager that fills on page load).
    let filled = lastLength > 1;

    input.addEventListener('input', onEvent);
    input.addEventListener('change', onEvent);
    const timer = setInterval(poll, pollMs);
    if (filled) settleThenFill();

    function onEvent(event) {
      changed(isTrusted(event));
    }

    function poll() {
      if (input.value.length !== lastLength) changed(false);
    }

    function changed(trusted) {
      if (!input.isConnected) {
        stop();
        return;
      }
      const now = performance.now();
      const length = input.value.length;
      const added = length - lastLength;
      if (added === 0) return; // an event that didn't change anything, e.g. the page re-dispatching one
      burst = added === 1 && now - lastChangeAt < BURST_GAP_MS ? burst + 1 : 1;
      lastLength = length;
      lastChangeAt = now;

      if (length === 0) {
        filled = false;
        clearTimeout(settle);
      } else if (!trusted || added > 1 || burst >= BURST_CHARS) {
        filled = true;
        settleThenFill();
      } else if (filled) {
        stop(); // the person has started typing over the fill: it's theirs to submit
      }
    }

    function settleThenFill() {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (!input.isConnected || input.value.length === 0) return;
        stop();
        onFill();
      }, settleMs);
    }

    function stop() {
      clearInterval(timer);
      clearTimeout(settle);
      input.removeEventListener('input', onEvent);
      input.removeEventListener('change', onEvent);
    }

    return stop;
  }

  // A checkbox whose label (or nearby text) contains labelText, ignoring case.
  function checkboxLabelled(labelText) {
    const want = normalise(labelText).toLowerCase();
    for (const box of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
      const label = [...(box.labels ?? [])].map((l) => l.textContent).join(' ');
      if (normalise(label).toLowerCase().includes(want)) return box;
      // No <label>: look a few levels up for the text.
      let el = box.parentElement;
      for (let i = 0; i < 4 && el; i += 1, el = el.parentElement) {
        if (normalise(el.textContent).toLowerCase().includes(want)) return box;
      }
    }
    return null;
  }

  function isChecked(box) {
    return box.type === 'checkbox' ? box.checked : box.getAttribute('aria-checked') === 'true';
  }

  // Calls onComplete once the input holds a complete code of `digits` digits (spaces and dashes
  // allowed) and has stayed that way for settleMs. Anything longer, such as an 8-digit backup
  // code, never counts. Returns a function that stops watching.
  function onCodeComplete(input, onComplete, { digits = 6, settleMs = 400, pollMs = 250 } = {}) {
    let settle = null;
    const complete = () => /^[\d\s-]*$/.test(input.value) && input.value.replace(/\D/g, '').length === digits;
    const check = () => {
      if (!input.isConnected) {
        stop();
        return;
      }
      clearTimeout(settle);
      if (!complete()) return;
      settle = setTimeout(() => {
        if (!complete()) return;
        stop();
        onComplete();
      }, settleMs);
    };
    let last = input.value;
    const timer = setInterval(() => {
      if (input.value !== last) {
        last = input.value;
        check();
      }
    }, pollMs);
    input.addEventListener('input', check);
    input.addEventListener('change', check);
    function stop() {
      clearInterval(timer);
      clearTimeout(settle);
      input.removeEventListener('input', check);
      input.removeEventListener('change', check);
    }
    check();
    return stop;
  }

  function highlight(el) {
    el.style.outline = '3px solid #e01e5a';
    el.style.outlineOffset = '2px';
  }

  // The extension's banner at the top of the page: a sign-in under way, a dry run, a recording.
  // Clicks go through it. With hideAfterMs it goes by itself; with hideOnInput, as soon as I type
  // or click anywhere on the page (my own input only: a password manager's fill doesn't count).
  let bannerTimer = null;
  let stopWatchingInput = null;
  function banner(text, { hideAfterMs, hideOnInput } = {}) {
    let el = document.getElementById('sas-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sas-banner';
      el.setAttribute('role', 'status');
      Object.assign(el.style, {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        maxWidth: 'calc(100vw - 32px)',
        padding: '8px 14px',
        borderRadius: '6px',
        background: '#4a154b',
        color: '#ffffff',
        font: '14px/1.4 system-ui, sans-serif',
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.3)',
        pointerEvents: 'none',
      });
      document.documentElement.append(el);
    }
    el.textContent = text;
    clearTimeout(bannerTimer);
    stopWatchingInput?.();
    stopWatchingInput = null;
    const hide = () => {
      clearTimeout(bannerTimer);
      stopWatchingInput?.();
      stopWatchingInput = null;
      el.remove();
    };
    if (hideAfterMs) bannerTimer = setTimeout(hide, hideAfterMs);
    if (hideOnInput) {
      const onInput = (event) => {
        if (event.isTrusted) hide();
      };
      for (const type of ['keydown', 'pointerdown']) document.addEventListener(type, onInput, true);
      stopWatchingInput = () => {
        for (const type of ['keydown', 'pointerdown']) document.removeEventListener(type, onInput, true);
      };
    }
  }

  return {
    isVisible,
    first,
    buttonWithText,
    accountRow,
    pageHasText,
    pageTextMatch,
    waitFor,
    press,
    setValue,
    onAutofilled,
    checkboxLabelled,
    isChecked,
    onCodeComplete,
    highlight,
    banner,
  };
})();
