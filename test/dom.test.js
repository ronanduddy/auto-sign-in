// Runs the content script's DOM helpers and selectors against fixture HTML.
// The Slack fixtures are the real markup captured on 2026-10-16 (see docs/selectors.md);
// the Google ones are stand-ins shaped like Google's pages.
import { test, equal, ok } from './harness.js';
import { sites } from './fixture.js';

const elementsOf = (id) => sites.byId(id).elements;

const D = globalThis.SAS_DOM;
const SEL = globalThis.SAS_SELECTORS;
const G = SEL.google.elements;
const SLACK = elementsOf('slack');

function mount(html) {
  const root = document.getElementById('fixture');
  root.innerHTML = html;
  return root;
}

const SLACK_GOOGLE_BUTTON = `
  <button class="c-button c-button--outline c-button--large c-third_party_auth c-google_login full_width"
          id="google_login_button" data-qa="base_google_login_button" aria-label="Google" type="button">
    <span class="c-button-loading__children"><span class="c-google_login__label"><span>Google</span></span></span>
  </button>`;

const SLACK_MFA = Array.from(
  { length: 6 },
  (_, i) => `<div class="two_factor_input_item"><input autocomplete="one-time-password" inputmode="numeric"
    pattern="\\d*" aria-disabled="false" maxlength="1" aria-label="digit ${i + 1} of 6" type="text" value=""></div>`,
).join('');

const GOOGLE_CHOOSER = `
  <h1>Choose an account</h1>
  <div>to continue to <a href="#">Slack</a></div>
  <ul>
    <li><div role="link" tabindex="0" id="row"><div>R</div><div><div>Me Person</div><div>Me@Example.org</div></div></div></li>
    <li><div role="link" tabindex="0" id="other"><div>Use another account</div></div></li>
  </ul>`;

test('finds Slack\'s Google button in the captured markup', () => {
  mount(SLACK_GOOGLE_BUTTON);
  equal(D.first(SLACK.googleButton.selectors)?.id, 'google_login_button');
});

test('finds Slack\'s MFA inputs and picks digit 1', () => {
  mount(SLACK_MFA);
  ok(D.first(SLACK.mfaInput.selectors), 'detected');
  equal(D.first(SLACK.mfaInput.selectors)?.getAttribute('aria-label'), 'digit 1 of 6', 'first selector wins');
});

test('finds the account row by its data attribute', () => {
  mount(`<div data-identifier="me@example.org" role="link" id="row">Me</div>`);
  equal(D.accountRow('ME@example.org', SEL.google.accountRowClickable)?.id, 'row');
});

test('finds the account row from the email text when there is no data attribute', () => {
  mount(GOOGLE_CHOOSER);
  equal(D.accountRow('me@example.org', SEL.google.accountRowClickable)?.id, 'row');
});

test('never picks another account or "Use another account"', () => {
  mount(GOOGLE_CHOOSER);
  equal(D.accountRow('someone@example.net', SEL.google.accountRowClickable), null);
  equal(D.accountRow('', SEL.google.accountRowClickable), null);
});

test('recognises the chooser and "Verify that it\'s you" text as seen', () => {
  mount(GOOGLE_CHOOSER);
  equal(D.pageTextMatch(SEL.google.continueTo), 'Slack', 'to continue to Slack');
  mount('<h1>Verify that it’s you</h1>');
  ok(D.pageHasText(SEL.google.verifyHeading), 'curly apostrophe');
  mount('<p>Please sign in again to continue to Gmail.</p>');
  equal(D.pageTextMatch(SEL.google.continueTo), 'Gmail.', 'Gmail is not Slack');
});

test('finds buttons by text, skipping hidden and disabled ones', () => {
  mount(`
    <button id="hidden" style="display:none">Continue</button>
    <button id="disabled" disabled>Continue</button>
    <div role="button" id="cancel">Cancel</div>
    <div role="button" id="go"><span> Continue </span></div>`);
  equal(D.buttonWithText(SEL.clickables, G.googleConsent.texts)?.id, 'go');
  equal(D.buttonWithText(SEL.clickables, G.googleNext.texts), null);
});

test('ignores Google\'s hidden autofill inputs', () => {
  mount(`
    <input type="password" aria-hidden="true" tabindex="-1" name="hiddenPassword">
    <input type="email" aria-hidden="true" tabindex="-1">`);
  equal(D.first(G.googlePassword.selectors), null, 'hidden password');
  equal(D.first(G.googleEmail.selectors), null, 'hidden email');
  mount('<input type="password" name="Passwd">');
  ok(D.first(G.googlePassword.selectors), 'real password box');
});

test("finds Google's email box as seen on its real sign-in page", () => {
  mount(`
    <input type="text" name="identifier" autocomplete="username" id="identifierId">
    <input type="password" name="hiddenPassword" aria-hidden="true" tabindex="-1">`);
  equal(D.first(G.googleEmail.selectors)?.id, 'identifierId');
});

test('waitFor resolves when the element turns up later', async () => {
  const root = mount('');
  setTimeout(() => root.insertAdjacentHTML('beforeend', SLACK_GOOGLE_BUTTON), 50);
  const el = await D.waitFor(() => D.first(SLACK.googleButton.selectors), 2000);
  equal(el.id, 'google_login_button');
});

test('waitFor gives up after its timeout', async () => {
  mount('');
  let failed = false;
  await D.waitFor(() => null, 50).catch(() => {
    failed = true;
  });
  ok(failed, 'rejected');
});

test('setValue updates the input and fires input events', () => {
  const root = mount('<input type="email" id="email">');
  const input = root.querySelector('#email');
  let events = 0;
  input.addEventListener('input', () => {
    events += 1;
  });
  D.setValue(input, 'me@example.org');
  equal(input.value, 'me@example.org');
  equal(events, 1);
});

test("finds Google's Allow button as the consent button too", () => {
  mount('<button id="cancel">Cancel</button><button id="allow">Allow</button>');
  equal(D.buttonWithText(SEL.clickables, G.googleConsent.texts)?.id, 'allow');
});

// How the content script finds a site element: selectors first, then whole-text matches.
function findSiteElement(spec) {
  return (spec.selectors && D.first(spec.selectors)) || (spec.texts && D.buttonWithText(SEL.clickables, spec.texts)) || null;
}

test("finds Dashboard's Google sign-in link", () => {
  mount('<a id="oauth" href="login/google"><svg></svg>Sign in with Google</a><a href="/forgot">Forgot your password?</a>');
  equal(findSiteElement(elementsOf('dashboard').signIn)?.id, 'oauth', 'by its href');
  mount('<a id="generic" href="login/generic_oauth">Sign in with Google</a>');
  equal(findSiteElement(elementsOf('dashboard').signIn)?.id, 'generic', 'by its text');
});

test("finds the Deploys site's LOG IN VIA GOOGLE button", () => {
  mount('<button id="sso" class="deploys-button deploys-button--base">LOG IN VIA GOOGLE</button><button>Sign In</button>');
  equal(findSiteElement(elementsOf('deploys-production').signIn)?.id, 'sso');
});

test("finds Error tracker's Google button", () => {
  mount('<a id="google" href="/identity/login/google/?next=/"><svg></svg>Google</a><a href="/identity/login/github/">GitHub</a>');
  equal(findSiteElement(elementsOf('errors').signIn)?.id, 'google', 'by its href');
  mount('<button id="g" type="button">Google</button><button type="button">GitHub</button>');
  equal(findSiteElement(elementsOf('errors').signIn)?.id, 'g', 'by its text');
});

test("finds Internal app's Sign in button in Rails' button_to markup", () => {
  mount(`
    <form class="button_to" method="post" action="/portal/auth/saml">
      <button class="btn btn-primary" button="true" data-method="post" type="submit">Sign in</button>
      <input type="hidden" name="authenticity_token" value="token">
    </form>`);
  equal(findSiteElement(elementsOf('internal-local').signIn)?.textContent, 'Sign in');
  mount('<form method="post" action="/portal/logout"><button type="submit">Sign in</button></form>');
  equal(findSiteElement(elementsOf('internal-local').signIn), null, 'only the SAML form');
});

test("finds the Feature flags site's Sign in with Google button", () => {
  mount('<form class="button_to" method="post" action="/auth/google_oauth2"><button type="submit" id="g">Sign in with Google</button></form>');
  equal(findSiteElement(elementsOf('flags').signIn)?.id, 'g', 'an OmniAuth form');
  mount('<div><button type="button" id="t">Sign in with Google</button><a href="/signup">Sign up</a></div>');
  equal(findSiteElement(elementsOf('flags').signIn)?.id, 't', 'by its text');
});

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Events dispatched from a test are always untrusted, so tests that stand in for a person
// typing tell onAutofilled to treat events as trusted.
const PERSON = { isTrusted: () => true };
const FAST = { settleMs: 60, pollMs: 20 };

function passwordBox(attributes = '') {
  return mount(`<input type="password" ${attributes}>`).querySelector('input');
}

function addCharacter(input, character) {
  input.value += character;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function watch(input, options) {
  const seen = { fills: 0, lengthAtFill: null };
  const stop = D.onAutofilled(
    input,
    () => {
      seen.fills += 1;
      seen.lengthAtFill = input.value.length;
    },
    { ...FAST, ...options },
  );
  return { seen, stop };
}

test('a password typed by a person is never treated as filled', async () => {
  const input = passwordBox();
  const { seen, stop } = watch(input, PERSON);
  for (const character of 'hunter2!') {
    addCharacter(input, character);
    await tick(70); // quick typing is still ~10 keys a second
  }
  await tick(150);
  stop();
  equal(seen.fills, 0);
});

test('a fill in one go is spotted once the box settles', async () => {
  const input = passwordBox();
  const { seen } = watch(input);
  D.setValue(input, 'filled-by-a-password-manager');
  await tick(150);
  equal(seen.fills, 1);
  D.setValue(input, '');
  D.setValue(input, 'filled-again');
  await tick(150);
  equal(seen.fills, 1, 'only once per page');
});

test('a password manager simulating keystrokes is spotted after its last one', async () => {
  const input = passwordBox();
  const { seen } = watch(input); // untrusted events, as from another extension
  for (const character of 'typed-by-a-manager') {
    addCharacter(input, character);
    await tick(10);
  }
  await tick(150);
  equal(seen.fills, 1);
  equal(seen.lengthAtFill, 'typed-by-a-manager'.length, 'waited for the whole password');
});

test('trusted keystrokes at machine speed count as a fill', async () => {
  const input = passwordBox();
  const { seen } = watch(input, PERSON);
  for (const character of 'inserted-quickly') addCharacter(input, character);
  await tick(150);
  equal(seen.fills, 1);
});

test('a value set without any event is caught by polling', async () => {
  const input = passwordBox();
  const { seen } = watch(input);
  input.value = 'set-without-events';
  await tick(200);
  equal(seen.fills, 1);
});

test('a password already filled before watching starts counts as filled', async () => {
  const input = passwordBox('value="prefilled-on-load"');
  const { seen } = watch(input);
  await tick(150);
  equal(seen.fills, 1);
});

test('typing over a fill hands the box back to the person', async () => {
  const input = passwordBox();
  let trusted = false;
  const { seen } = watch(input, { isTrusted: () => trusted, settleMs: 200 });
  D.setValue(input, 'wrong-password');
  await tick(50);
  trusted = true; // now the person edits it
  input.value = input.value.slice(0, -1);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(300);
  equal(seen.fills, 0);
});

test('events that do not change the value are ignored', async () => {
  const input = passwordBox();
  const { seen, stop } = watch(input, PERSON);
  addCharacter(input, 'a');
  for (let i = 0; i < 5; i += 1) input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(150);
  stop();
  equal(seen.fills, 0);
});

test('finds the "Don\'t ask again on this device" checkbox by its label or nearby text', () => {
  mount('<input type="checkbox" id="remember"><label for="remember">Don’t ask again on this device</label>');
  equal(D.checkboxLabelled(SEL.google.rememberDeviceLabel)?.id, 'remember', 'a <label>, curly apostrophe');
  mount('<div><div><input type="checkbox" id="nearby"></div><div>Don\'t ask again on this device</div></div>');
  equal(D.checkboxLabelled(SEL.google.rememberDeviceLabel)?.id, 'nearby', 'text alongside');
  mount('<div role="checkbox" aria-checked="false" id="aria">Don\'t ask again on this device</div>');
  const aria = D.checkboxLabelled(SEL.google.rememberDeviceLabel);
  equal(aria?.id, 'aria', 'an ARIA checkbox');
  ok(!D.isChecked(aria), 'reads aria-checked');
  mount('<input type="checkbox" id="other"><label for="other">Stay signed in</label>');
  equal(D.checkboxLabelled(SEL.google.rememberDeviceLabel), null, 'not another checkbox');
});

test('a 6-digit code counts as complete once typing stops, once', async () => {
  const input = mount('<input type="tel" id="totpPin">').querySelector('input');
  let completions = 0;
  D.onCodeComplete(input, () => (completions += 1), { settleMs: 60, pollMs: 20 });
  for (const digit of '12345') addCharacter(input, digit);
  await tick(120);
  equal(completions, 0, '5 digits');
  addCharacter(input, '6');
  await tick(120);
  equal(completions, 1, '6 digits');
  addCharacter(input, '7');
  await tick(120);
  equal(completions, 1, 'only once');
});

test('a code with a space counts; a longer backup code never does', async () => {
  const spaced = mount('<input id="a">').querySelector('input');
  let spacedDone = 0;
  D.onCodeComplete(spaced, () => (spacedDone += 1), { settleMs: 60, pollMs: 20 });
  D.setValue(spaced, '123 456');
  await tick(120);
  equal(spacedDone, 1, '"123 456"');

  const backup = mount('<input id="b">').querySelector('input');
  let backupDone = 0;
  D.onCodeComplete(backup, () => (backupDone += 1), { settleMs: 60, pollMs: 20 });
  for (const digit of '12345678') addCharacter(backup, digit);
  await tick(120);
  equal(backupDone, 0, '8 digits typed quickly: no pause at 6');
});

test("reads the app name on Google's Continue and Allow pages", () => {
  const appOn = (html) => {
    mount(html);
    return SEL.google.consentApp.map((pattern) => D.pageTextMatch(pattern)).find(Boolean) ?? null;
  };
  equal(appOn('<h1>Sign in to Slack</h1><button>Continue</button>'), 'Slack');
  equal(appOn('<h1>Example Ops Staging wants access to your Google Account</h1>'), 'Example Ops Staging');
  equal(appOn('<h1>Choose an account</h1>'), null);
});

test('press fires mousedown and click', () => {
  const root = mount('<div role="link" id="row">Me</div>');
  const seen = [];
  const row = root.querySelector('#row');
  for (const type of ['mousedown', 'mouseup', 'click']) row.addEventListener(type, () => seen.push(type));
  D.press(row);
  equal(seen, ['mousedown', 'mouseup', 'click']);
});

test("the extension's banner lets clicks through, and can go by itself", async () => {
  D.banner('Auto sign-in: signing in to Acme…');
  const el = document.getElementById('sas-banner');
  equal([el.textContent, el.style.pointerEvents], ['Auto sign-in: signing in to Acme…', 'none']);
  D.banner('Auto sign-in: signed in to Acme.', { hideAfterMs: 30 });
  equal(document.getElementById('sas-banner').textContent, 'Auto sign-in: signed in to Acme.', 'one banner, updated');
  await new Promise((resolve) => setTimeout(resolve, 60));
  ok(!document.getElementById('sas-banner'), 'gone');
});

test('a banner that waits for me goes on my first keystroke or click, not on a script\'s', () => {
  D.banner('Auto sign-in: over to you on Acme\'s 2FA page.', { hideOnInput: true });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  ok(document.getElementById('sas-banner'), 'an untrusted keystroke (a script, a password manager) leaves it');
  document.getElementById('sas-banner').remove();
});
