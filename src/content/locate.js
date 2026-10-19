// For the recorder (recorder.js): how a sign-in run will find, next time, an element I used while
// recording. It prefers the element's text (what the engine's buttonWithText() matches) and a
// selector built from stable attributes: an id, a test id, a name, a link or form address. It
// never uses generated class names, and only falls back to the element's position on the page,
// marked fragile, when nothing else picks it out. Nothing here reads what's in a box, only whether
// it's empty.
globalThis.SAS_LOCATE = (() => {
  const D = globalThis.SAS_DOM;
  const SEL = globalThis.SAS_SELECTORS;

  // What counts as clicking something: the engine's clickables, plus form buttons.
  const CLICKABLE = `${SEL.clickables}, input[type="submit"], input[type="button"], input[type="image"]`;
  const TEXT_INPUT = 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="number"]';
  const MAX_TEXT = 60;

  const normalise = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
  const quote = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;

  // Values a framework made up, which change between page loads or releases: long digit runs,
  // hex hashes, React/Radix/Ember ids, and anything with a colon.
  function looksGenerated(value) {
    return /\d{4,}|[0-9a-f]{8,}|[:]|^(ember|react|radix|mui|headlessui|rc-|r\d)/i.test(value);
  }

  function isUnique(selector, el) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el;
    } catch {
      return false;
    }
  }

  // The path of an address without its query, hash or a generated last segment.
  function addressPath(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin ? url.pathname : `${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
  }

  // The stable selectors that pick out exactly this element, best first.
  function stableSelectors(el) {
    const tag = el.tagName.toLowerCase();
    const candidates = [];
    if (el.id && !looksGenerated(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
    for (const name of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
      const value = el.getAttribute(name);
      if (value && !looksGenerated(value)) candidates.push(`${tag}[${name}=${quote(value)}]`);
    }
    const name = el.getAttribute('name');
    if (name && !looksGenerated(name)) candidates.push(`${tag}[name=${quote(name)}]`);
    if (tag === 'input') {
      const type = el.getAttribute('type');
      if (type === 'email') candidates.push('input[type="email"]');
      const autocomplete = el.getAttribute('autocomplete');
      if (autocomplete && autocomplete !== 'off') candidates.push(`input[autocomplete=${quote(autocomplete)}]`);
      if (/^(submit|button)$/.test(type ?? '') && el.value && el.value.length <= MAX_TEXT) candidates.push(`input[type=${quote(type)}][value=${quote(el.value)}]`);
    }
    if (tag === 'a' && el.getAttribute('href')) {
      const href = el.getAttribute('href');
      const path = addressPath(href);
      if (path && !looksGenerated(path) && path !== '/') {
        candidates.push(href.split(/[?#]/)[0] === href ? `a[href=${quote(href)}]` : `a[href^=${quote(href.split(/[?#]/)[0])}]`);
      }
    }
    const form = el.closest('form[action]');
    const action = form && addressPath(form.getAttribute('action'));
    if (action && !looksGenerated(action) && action !== '/' && (el.type === 'submit' || tag === 'button')) {
      candidates.push(`form[action*=${quote(new URL(form.getAttribute('action'), location.href).pathname)}] ${tag}`);
    }
    const label = el.getAttribute('aria-label');
    if (label && label.length <= MAX_TEXT) candidates.push(`${tag}[aria-label=${quote(label)}]`);
    return candidates.filter((selector) => isUnique(selector, el));
  }

  // The element's position, as a last resort: tag names and nth-of-type from the nearest
  // ancestor with a stable id (or the body).
  function positionSelector(el) {
    const parts = [];
    for (let node = el; node && node !== document.body && node.nodeType === 1; node = node.parentElement) {
      if (node !== el && node.id && !looksGenerated(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const sameTag = [...(node.parentElement?.children ?? [])].filter((child) => child.tagName === node.tagName);
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
    }
    if (!parts[0]?.startsWith('#')) parts.unshift('body');
    return parts.join(' > ');
  }

  // The text a run would find it by, if that finds this element (the first visible match wins).
  function textOf(el) {
    const text = normalise(el.textContent);
    if (!text || text.length > MAX_TEXT) return null;
    return D.buttonWithText(SEL.clickables, [text]) === el ? text : null;
  }

  // The thing a click landed in that counts as clicking: a link, a button…
  function clickableFor(target) {
    const el = target?.closest?.(CLICKABLE);
    return el && !el.matches('input[type="checkbox"], input[type="radio"]') ? el : null;
  }

  // How a run finds a clicked element: { selectors?, texts?, fragile? }.
  function describeClick(el) {
    const text = textOf(el);
    const [selector] = stableSelectors(el);
    if (!text && !selector) return { selectors: [positionSelector(el)], fragile: true };
    return { ...(selector && { selectors: [selector] }), ...(text && { texts: [text] }) };
  }

  // How a run finds a box (an email or code box): { selectors, fragile? }.
  function describeField(el) {
    const [selector] = stableSelectors(el);
    return selector ? { selectors: [selector] } : { selectors: [positionSelector(el)], fragile: true };
  }

  // The words a box is described by, with names like account[security_code] split into words.
  const attrs = (el) =>
    ['type', 'name', 'id', 'autocomplete', 'placeholder', 'aria-label']
      .map((name) => el.getAttribute(name) ?? '')
      .join(' ')
      .replace(/[_[\]-]+/g, ' ');

  // A box for an email or username (never a password box).
  function isEmailField(el) {
    if (!el?.matches?.(TEXT_INPUT)) return false;
    return el.type === 'email' || /e-?mail|user(name)?\b|login|identifier/i.test(attrs(el));
  }

  // A box for a one-time code: the site's own two-factor step.
  function isCodeField(el) {
    if (!el?.matches?.(TEXT_INPUT)) return false;
    if (/one-time-code/.test(el.getAttribute('autocomplete') ?? '')) return true;
    return /\b(otp|totp|mfa|2fa|two.?factor|verification|passcode|security.?code|auth.?code|code|token)\b/i.test(attrs(el));
  }

  const isPasswordField = (el) => el?.matches?.('input[type="password"]') ?? false;
  const isFilled = (box) => box.value.trim() !== '';

  // Email boxes showing and empty, for the recorder to fill in with my Google email.
  function emptyEmailBoxes() {
    return [...document.querySelectorAll('input')].filter((box) => isEmailField(box) && D.isVisible(box) && !box.disabled && !box.readOnly && !isFilled(box));
  }

  // The email box that goes with a click, if any: the one filled in or typed in last (candidate),
  // when it's in the same form as what was clicked (or neither is in a form); otherwise a filled-in
  // email box in the clicked element's form, however it got filled (a password manager, the site).
  function emailBoxFor(clicked, candidate) {
    const form = clicked.closest('form');
    if (candidate?.isConnected && candidate.closest('form') === form && isFilled(candidate)) return candidate;
    if (!form) return null;
    return [...form.querySelectorAll('input')].find((box) => isEmailField(box) && D.isVisible(box) && isFilled(box)) ?? null;
  }

  // The page's path as a step's path: no trailing slash, and cut before a segment that looks
  // generated (an id or a token), since a step's path matches every address starting with it.
  function stablePath(pathname) {
    const kept = [];
    for (const segment of pathname.split('/').filter(Boolean)) {
      if (looksGenerated(segment)) break;
      kept.push(segment);
    }
    return `/${kept.join('/')}`;
  }

  return {
    clickableFor,
    describeClick,
    describeField,
    emailBoxFor,
    emptyEmailBoxes,
    isEmailField,
    isCodeField,
    isPasswordField,
    stablePath,
    looksGenerated,
  };
})();
