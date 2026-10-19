// The recorder's element descriptions (src/content/locate.js): how a run finds, next time, what I
// clicked or typed in while recording. Each description must find that same element.
import { test, equal, ok } from './harness.js';

const L = globalThis.SAS_LOCATE;
const D = globalThis.SAS_DOM;
const SEL = globalThis.SAS_SELECTORS;

function mount(html) {
  document.getElementById('fixture').innerHTML = html;
}
const $ = (selector) => document.querySelector(selector);

// What a run would find from a description (selectors first, then texts), as agent.js does.
const finds = (description) => (description.selectors && D.first(description.selectors)) || (description.texts && D.buttonWithText(SEL.clickables, description.texts));

test('a link or button: its text, and a stable id', () => {
  mount('<header><a href="https://login.acme.example.test/login" id="log-in">Log in</a></header><button id="radix-:r1:">Continue</button>');
  equal(L.describeClick($('#log-in')), { selectors: ['#log-in'], texts: ['Log in'] });
  const generated = L.describeClick(document.querySelector('button'));
  equal(generated, { texts: ['Continue'] }, 'a generated id is left out');
});

test('attributes made for tests or forms, when there is no id', () => {
  mount(`
    <button data-testid="google-sign-in"><svg></svg></button>
    <form action="/auth/saml?x=1" method="post"><button type="submit">Sign in</button></form>
    <input type="submit" value="Log in with SSO">
    <a href="/oauth/start?state=abc123">Google</a>`);
  equal(L.describeClick($('[data-testid]')), { selectors: ['button[data-testid="google-sign-in"]'] }, 'no text: the test id');
  equal(L.describeClick($('form button')), { selectors: ['form[action*="/auth/saml"] button'], texts: ['Sign in'] });
  equal(L.describeClick($('input[type="submit"]')), { selectors: ['input[type="submit"][value="Log in with SSO"]'] });
  equal(L.describeClick($('a')), { selectors: ['a[href^="/oauth/start"]'], texts: ['Google'] }, "a link's address without its query");
});

test('nothing stable: its position, marked fragile, and it still finds the element', () => {
  mount('<div><div class="x1"><span class="css-9f8e7d">→</span><span class="css-9f8e7d" role="button"></span></div></div>');
  const el = document.querySelectorAll('[role="button"]')[0];
  const description = L.describeClick(el);
  ok(description.fragile, 'fragile');
  equal(finds(description), el);
});

test('every description finds the element it describes', () => {
  mount(`
    <a href="/start" id="start">Start</a>
    <button name="provider" value="google">Continue with Google</button>
    <button aria-label="Close"><svg></svg></button>`);
  for (const el of document.querySelectorAll('#fixture a, #fixture button')) equal(finds(L.describeClick(el)), el, el.outerHTML);
});

test('clicks count on links and buttons, through their insides, but not on checkboxes', () => {
  mount('<button id="b"><span id="inner">Go</span></button><input type="checkbox" id="c"><p id="p">text</p>');
  equal(L.clickableFor($('#inner')), $('#b'));
  equal(L.clickableFor($('#c')), null);
  equal(L.clickableFor($('#p')), null);
});

test('email, code and password boxes', () => {
  mount(`
    <input id="email" type="email">
    <input name="username" autocomplete="username">
    <input id="search" type="text" placeholder="Search">
    <input id="otp" autocomplete="one-time-code" inputmode="numeric">
    <input name="account[security_code]" type="text">
    <input id="pw" type="password">`);
  ok(L.isEmailField($('#email')) && L.isEmailField($('[name="username"]')), 'email and username boxes');
  ok(!L.isEmailField($('#search')) && !L.isEmailField($('#pw')), 'not a search box or a password box');
  ok(L.isCodeField($('#otp')) && L.isCodeField($('[name="account[security_code]"]')), 'code boxes');
  ok(!L.isCodeField($('#email')), 'not an email box');
  ok(L.isPasswordField($('#pw')));
  equal(L.describeField($('#email')), { selectors: ['#email'] });
  equal(L.describeField($('[name="username"]')), { selectors: ['input[name="username"]'] });
});

test("a step's path stops before anything that looks generated", () => {
  equal(L.stablePath('/'), '/');
  equal(L.stablePath('/u/login/'), '/u/login');
  equal(L.stablePath('/org/123456/login'), '/org');
  equal(L.stablePath('/login/7f3a9c2e1b44'), '/login');
});

test("the email box that goes with a click: filled in, and in the clicked button's form", () => {
  mount(`
    <form id="f"><input id="email" type="email"><button id="go" type="submit">Continue</button></form>
    <a id="sso" href="/sso">Use SSO instead</a>
    <input id="news" type="email" placeholder="Newsletter">`);
  const box = $('#email');
  equal(L.emptyEmailBoxes().map((el) => el.id), ['email', 'news'], 'empty email boxes showing');
  equal(L.emailBoxFor($('#go'), null), null, 'nothing filled in yet');
  box.value = 'someone@example.org'; // a password manager, say
  equal(L.emailBoxFor($('#go'), null), box, "a filled box in the button's form counts, however it was filled");
  equal(L.emailBoxFor($('#go'), box), box, 'the one filled in last');
  equal(L.emailBoxFor($('#sso'), box), null, 'not for a link outside its form');
  $('#news').value = 'x';
  equal(L.emailBoxFor($('#sso'), $('#news')), $('#news'), 'neither in a form');
  box.value = '';
  equal(L.emailBoxFor($('#go'), box), null, 'emptied again');
  equal(L.emptyEmailBoxes().map((el) => el.id), ['email']);
});
