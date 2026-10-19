# Selectors and URLs (recon notes)

Every selector built into the extension, with where it came from: Slack's live in `src/sites/types/slack.js`, and Google's, which every site shares, in `src/content/selectors.js`. When Slack or Google changes its UI, update the code and this file together. Every other site's selectors are in its config entry, written by the recorder (see the end of this file).

The mock pages in `test/e2e/pages/` copy these pages' structure, so update them too when a selector changes for a real reason.

## Slack: URL sequence (mapped 2026-10-16)

Everything happens in one tab; Google opens in the same tab.

| # | Page | URL | Status |
|---|------|-----|--------|
| 1 | Sign-out landing (workspace picker) | `https://app.slack.com/workspace-signin?redir=…teams%3DT0123ABCD` (when Slack signs you out), or bare `https://app.slack.com/workspace-signin` | Seen |
| 2 | Sign-in options (Google / Apple / email) | `https://acme.slack.com/` | Seen |
| 3 | Google account chooser | `https://accounts.google.com/v3/signin/accountchooser` | Seen |
| 4 | Google password (only when Google's session has lapsed) | `https://accounts.google.com/v3/signin/challenge/pwd` | Seen |
| 5 | Google "sign in to Slack" page with Continue | `https://accounts.google.com/signin/oauth/id` | Seen |
| 6 | Slack MFA ("Enter your authentication code") | `https://acme.slack.com/` (same URL as #2) | Seen |
| 7 | Desktop-app launcher: "Launching acme" and the browser's "Open Slack?" prompt | `https://acme.slack.com/ssb/redirect?entry_point=workspace_signin` | Seen |
| 8 | Slack in the browser: a chosen channel, or the workspace's default view | `https://app.slack.com/client/T0123ABCD/C0123ABCD` | Seen (the redirect rules land here) |

The workspace (`acme`), team ID (`T0123ABCD`) and channel here are made up; the URLs' shapes are as seen.

Not in the Slack flow so far, but handled if they appear:

- Google "Verify that it's you". Seen once, reached via Gmail.
- Google's email page.
- A Google 2-Step prompt.

## Slack

### Sign-in options page: Google button

```html
<button class="c-button c-button--outline c-button--large c-third_party_auth c-google_login full_width"
        id="google_login_button" data-qa="base_google_login_button"
        aria-label="Google" type="button">…<span>Google</span>…</button>
```

- Primary: `[data-qa="base_google_login_button"]`
- Fallback: `#google_login_button`
- Notes: `type="button"` (handled by JS, not a form submit). It has a loading state, so click it only once.

### MFA page

The page heading says "Enter your authentication code". There are six inputs like this, one per digit:

```html
<div class="two_factor_input_item">
  <input autocomplete="one-time-password" inputmode="numeric" pattern="\d*" aria-disabled="false"
         maxlength="1" aria-label="digit 1 of 6" type="text" value="">
</div>
```

- Detection: `input[autocomplete="one-time-password"]`. The fallback is `.two_factor_input_item input`, which is a hand-written class, not a generated one.
- Focus: `[aria-label="digit 1 of 6"]`, or the first matching input if that label isn't there.
- The URL is the same as the sign-in options page, so the page has to be identified from its DOM. Never reload this page.

### Desktop-app launcher (`/ssb/redirect`)

- The page says "Launching" and the workspace's name, followed by "Click on 'Open Slack' to launch the desktop app. Not working? You can also use Slack in your browser."
- The "Open Slack?" prompt comes from the browser itself because the page triggers a `slack://` link, so the page's DOM can't dismiss it.
- Handling: with "Skip the Open Slack? prompt" on, a declarativeNetRequest rule redirects this URL to Slack in the browser before the page loads (the chosen page, or the workspace's default view), so no selectors are needed. Opening a chosen page instead of the default view is a second, separate rule on `app.slack.com/client/<team ID>` itself.

### Workspace picker

Not needed: the extension replaces the picker with the workspace's own address (`https://acme.slack.com/`) instead of filling in the form.

## Google

### Account chooser (`/v3/signin/accountchooser`)

- Seen 2026-10-16. The header says "Sign in with Google", the heading says "Choose an account" and the subtitle says "to continue to **Slack**" (Slack is a link). There are two rows: the work account and "Use another account". The chooser appears even though only one account is signed in.
- Slack check: the URL parameters contain `slack.com`, or the page says "to continue to Slack".
- Account row: find the element whose text is exactly the configured email, go up to its clickable ancestor (`[data-identifier]`, `[role=link]` or `li`) and click it. Never click "Use another account". Text matching worked on the real page on 2026-10-16. The exact outerHTML is still to capture.

### Password (`/v3/signin/challenge/pwd`): wait for user, never fill in

- Detection: the URL path. On pages without a known path, look for a visible `input[type=password]` that isn't `aria-hidden` or `tabindex="-1"`. Google keeps hidden password and email inputs on its pages for autofill, and those must be skipped.
- Action: focus the field, plus a notification if the tab is hidden. Once a password manager fills the field, click Next: the `button` whose text is "Next" (historically inside `#passwordNext`; exact outerHTML still to capture).

### Continue and Allow (`/signin/oauth/…`)

- `/signin/oauth/id` ("Sign in to Slack") has a Continue button; `/signin/oauth/v2/consentsummary` (apps asking for more than your basic profile) has Allow. Both are found by text: `googleConsent` matches "Continue" or "Allow".
- Continue button: the `button` whose text is "Continue". This worked on the real page on 2026-10-16. The exact outerHTML is still to capture.

### Email page (`/v3/signin/identifier`), seen 2026-10-16

- When Google has no account to offer, this page appears. The email box is `<input type="text" name="identifier" autocomplete="username" id="identifierId">`, not `type="email"`.
- Next is a `button` with the text "Next".
- A hidden `input[type=password][name=hiddenPassword]` (`aria-hidden`, `tabindex=-1`) sits alongside for autofill.
- The extension recognises the page by its address.

### 2-Step Verification (`/v3/signin/challenge/totp`), seen 2026-10-16

- Google Authenticator: "Enter code" box, a "Don't ask again on this device" checkbox (ticked by default when seen), "Try another way" and Next.
- Code box: `input#totpPin` / `name="totpPin"`, falling back to `autocomplete="one-time-code"` or a `tel` input. (Google's usual markup; the exact outerHTML is still to capture.)
- Checkbox: found by its label text, "ask again on this device" (the label uses a curly apostrophe). It's an `input[type=checkbox]` with a `<label>`, or a nearby text node, or `role=checkbox`.
- Next: `button` with the text "Next".
- Backup codes (`/v3/signin/challenge/bc`, 8 digits) are never submitted automatically.

### Edge pages (not seen in the Slack flow yet)

- "Verify that it's you": the heading text and the account's email, plus a Next button (`button` with text "Next"). Check that the email matches, then click Next.
- Email page: `input[type=email]`, then Next.
- 2-Step: wait for the user.

## Recorded sites

Other sites' selectors come from recording a sign-in (Options → Record a site). For each element you click, the recorder (`src/content/locate.js`) keeps its whole text, and a selector only from stable attributes: an id that doesn't look generated, a test id, a `name`, a link's address without its query, a form's action, or an `aria-label`. Only when none of those picks out the element does it fall back to the element's position on the page, and the review marks that step as fragile. Text matches are whole-text and case-insensitive.

When a recorded site breaks, record it again, or edit its steps' JSON in the options. A dry run from the popup shows what each step would click.
