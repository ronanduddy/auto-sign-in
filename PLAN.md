# Auto sign-in (Chrome extension): the original plan, when it was for Slack alone

> **Status (2026-10-16):** v0.1.0 is built and works on the real pages. A dry run, then live runs by hand, went from the Google button through the account chooser and Continue to Slack's MFA, and landed on the channel with no "Open Slack?" prompt.
>
> Still to see in real use:
> - an unattended sign-out by Slack;
> - the Next click after a password manager fills the password.
>
> Since then it has grown from Slack alone to any site that signs in through Google (see **Sites beyond Slack**). Slack and Google itself are built in; every other site is recorded once, in the options. The workspace, team and channel IDs below are made up; the URLs' shapes are as seen.
>
> [README.md](README.md) covers installing and using it.

## Problem

The workspace's session policy signs me out of `acme.slack.com` regularly and sends me to:

```
https://app.slack.com/workspace-signin?redir=%2Fgantry%2Fauth%3Fapp%3Dclient%26lc%3D...%26return_to%3D%252Fclient%252FT0123ABCD%252FC0456EFGH%26teams%3DT0123ABCD
```

Getting back in takes nine steps, and only two of them need me:

1. Refresh the page (its CSRF "crumb" goes stale if the tab has been open a while).
2. Type `acme` and click Continue.
3. Click Google on the sign-in options page (Google, Apple or email).
4. Click my account on Google's "Choose an account… to continue to Slack" page.
5. **Enter my Google password**, if Google's own session has lapsed (it had on the morning of 2026-10-16).
6. Click Continue on Google's "sign in to Slack" page.
7. **Enter Slack's 6-digit MFA code.**
8. Cancel the browser's "Open Slack?" prompt for the desktop app.
9. Click "use Slack in your browser", then go to the channel I actually want.

## Goal

A Manifest V3 extension, loaded unpacked in Chrome, that does every step except 5 and 7 and finishes on `https://app.slack.com/client/T0123ABCD/C0123ABCD`. When it needs me, it focuses the right input. If the tab isn't in front, it also shows a notification.

## Guardrails

These are design constraints, not nice-to-haves.

- **Never touches secrets.** It never reads, stores or fills in a password or MFA code. Cookies and tokens are never read or stored. ("Sign out of all" deletes the sites' cookies through `chrome.browsingData`, by origin, without reading them.) The extension waits for me at Google's password page, at a Google 2-Step page if one ever appears, and at Slack's MFA page.
- **One exception, at my request (2026-10-16):** on Google's password page it clicks Next once my password manager has filled the password in.
  - It looks only at the length of what's in the box and at the input events, never at the password itself.
  - It submits only when something other than my keystrokes filled the box: a password manager or a paste. A password I type is left for me to submit with Enter, and typing over a fill hands the box back to me.
  - It submits at most once per page, so a wrong password can't loop.
  - It can be switched off in the options.
- **A second exception, also at my request (2026-10-16): Google's 2-Step page.**
  - It ticks "Don't ask again on this device" (found by its label text) and focuses the code box.
  - It clicks Next once the box holds a complete 6-digit code and hasn't changed for 400ms, once per page.
  - It never reads or keeps the code, only checks it's 6 digits.
  - Backup-code pages (8 digits) and 2-Step pages without a code box (e.g. "Check your phone") are left to me, and the run waits there instead of failing.
  - There's an option to switch it off.
- **Leaves the session policy alone.** The 12h sign-out and MFA still happen. The extension only automates the clicks between them.
- **Narrow scope.** The manifest's own access covers only Google's sign-in pages. Each site's host is granted at runtime, when it's imported or added, and given back when it's removed. On Google, it runs only on Google's sign-in paths, and acts only while a run the extension started is active and has been confirmed to be for that run's site. A run is active for ~2 minutes after its latest step, or up to 10 minutes while it's waiting for my password.
- **Imported sites are reviewed.** Google's Continue/Allow is clicked during a run for its own site. A config file could point a site at a host running its own Google app, so importing one shows every site and host before anything is saved. (Versions 0.4 to 0.7 also asked to approve each app on its first Continue/Allow. That was removed on 2026-10-16 as not needed: sites come from my own recordings, or from a file I've reviewed.)
- **Can't loop.** At most 3 automatic runs per site per 15 minutes; a run that signs me in or reaches MFA resets that site's count, because it proves the flow isn't stuck. After that it pauses and sends a notification. A stuck automation that keeps hitting Google sign-in can get an account locked.
- **Easy to turn off.** The toolbar popup has an on/off toggle and a dry-run mode.

## The flow (mapped 2026-10-16)

Google opens in the same tab, so the whole flow happens in one tab.

| # | URL | What's there | Extension does |
|---|-----|--------------|----------------|
| 1 | `app.slack.com/workspace-signin?redir=…teams%3DT0123ABCD`, or the bare `app.slack.com/workspace-signin` after signing out by hand | Workspace picker | `location.replace('https://acme.slack.com/')` |
| 2 | `acme.slack.com/` | Sign-in options: Google, Apple, email | Reload if stale, then click the Google button |
| 3 | `accounts.google.com/v3/signin/accountchooser` | "Choose an account… to continue to Slack" | Check it's for Slack, then click the row with my email |
| 4 | `accounts.google.com/v3/signin/challenge/pwd` | Google password (only when Google's session has lapsed) | **Wait for me**: focus the field; click Next once a password manager fills it |
| 5 | `accounts.google.com/signin/oauth/id` | Google's "sign in to Slack" page | Click Continue |
| 6 | `acme.slack.com/` | Slack MFA: six single-digit inputs | **Wait for me**: focus digit 1. Never reload |
| 7 | `acme.slack.com/ssb/redirect?entry_point=workspace_signin` | "Launching acme" page and the browser's "Open Slack?" prompt | Never loads: the request is redirected to my channel |
| 8 | `app.slack.com/client/T0123ABCD/C0123ABCD` | Slack in the browser | Done |

Google didn't ask for its own 2-Step code after the password.

The table reveals two things that shape the design:

- **Steps 2 and 6 have the same URL.** The extension tells the sign-in page and the MFA page apart by what's on the page, not by the address.
- **The "Open Slack?" prompt at step 7 belongs to the browser, not the page.** No content script can click its Cancel button. The fix is to stop that page loading at all (decision 4).

Google pages that haven't appeared in the Slack flow yet, but might:

- **"Verify that it's you"** (seen once, reached via Gmail): check the email shown, then click Next.
- **The email page** (if Google forgets the account): type the email, then click Next.
- **A Google 2-Step prompt:** wait for me.

## Sites beyond Slack (added 2026-10-16)

Each site is a "loop". Slack and Google itself are built in (`src/sites/types/`); every other site is a `button` site in the config, usually written by recording a sign-in once (Options → Record a site). `src/sites/index.js` documents the definition the engine sees:

- **Where the site's pages are** (`matches`), granted at runtime.
- **Which elements to look for** (`elements`): selectors or whole-text matches, optionally limited to a host or path. It's plain data, sent to the generic content script.
- **What each page is** (`classify()`). One of four steps, or nothing:
  - `redirect` goes straight to the real sign-in page (Slack's picker);
  - `login` does one of the site's sign-in steps (click, or fill in my email and click), optionally reloading a stale page first;
  - `handover` focuses a box for me and ends the run;
  - `signedIn` means the run is done.
- **How to recognise its Google sign-in** (`google`): text that appears in Google's URL (usually its host), and its app name in Google's "to continue to …" line.

The engine handles everything shared: runs, Google's pages (chooser, password, 2-Step, Continue/Allow), the per-site loop guard, one run at a time per site across tabs (others retry), and Slack's signed-in badge.

| Site | Hosts | Flow | How sure are the selectors? |
|---|---|---|---|
| Google | `accounts.google.com/v3/signin/*` | Google's own sign-in, started on its own: account chooser, Verify, email, password, 2-Step. Never Continue/Allow | Shared with every site's flow |
| Slack | `app.slack.com`, `acme.slack.com` | Picker redirect, Google button, Google, MFA hand-over, then the "Open Slack?" skip and the page to open, as separate settings | Confirmed on the real pages |
| Any other site | Its own, plus any sign-in host its steps go through | Its recorded steps (a "Log in" link, an email box, a Google button…), Google, an optional hand-over at its own code page | Recorded from the real pages; a dry run checks them |

Notes:

- **Allow pages.** Google's consent step clicks Continue or Allow, whichever is there. Apps that ask Google for consent on every sign-in show one or both.
- **SAML sign-ins.** Google's URL doesn't name the app, so the check is Google's SAML endpoint (`saml2`) in the URL, or the app's name in the chooser's "to continue to …" line, which the recorder notes when the URL doesn't name the site.
- **The Google loop.** Every site's flow already runs Google's steps as part of its run, so sites don't depend on the Google loop explicitly. The loop covers landing on Google's sign-in directly. With no run in the tab, a Google page starts one only if it's a sign-in to Google itself: no OAuth client, SAML request or third-party redirect in the URL, and continuing (if anywhere) to a Google site. It never clicks Continue/Allow. Google then sends the tab somewhere the content script can't follow, so leaving a Google page (`pagehide`) starts an 8-second grace period. If no other Google page turns up, the run ends as signed in, or quietly if the tab was closed.
- **After signing in to Google (made instant 2026-10-16).** Signed in with nowhere else to go, Google lands on `myaccount.google.com/?utm_source=sign_in_no_continue&pli=1`.
  - The Google site's declarativeNetRequest rule redirects that address, before it loads, to `https://mail.google.com/mail/`, the same way Slack's rules work.
  - It only matches addresses carrying those post-sign-in markers, so visiting My Account by hand is untouched, as is any sign-in on its way to Gmail, Drive and so on.
  - Fallback: if the Google loop's tab still ends up on My Account, the run's end sends it on. That happens after the 8-second leave grace, judged from the tab's actual address.
  - It's an option, on by default, with the address editable. It needs host access to `myaccount.google.com`.
- **Checked on a real site, 2026-10-16.** Two bugs turned up:
  - A sign-in page still showing after 3 seconds was reported again as "settled" and counted as a new attempt, which clicked again. Settling now only counts on pages with none of the site's elements.
  - Google's email page uses `input#identifierId` (`type=text`), so it wasn't recognised; it's now spotted by its address.
- **Sign out of all (added 2026-10-16).** The popup button clears every site's cookies with `chrome.browsingData.remove({ origins }, { cookies: true })`, which clears each origin's whole registrable domain (all of `google.com`, and all of `example.com` for `app.example.com`). It also ends any runs and switches auto sign-in off, or open tabs would sign straight back in. A two-step confirmation in the popup says all this first.
- **Links and labels.** Each site has a `home` page; the popup and options link to it in a new tab, and opening it while signed out starts the loop. A site's labels (such as "requires VPN") show beside it.
- **One run per tab, and per site (changed 2026-10-16).** At first there was one run at a time across the whole browser. A run waiting for a password, or one whose end went unnoticed, then held up every other site for 2–10 minutes, which made other sites look flaky until the extension was reloaded (which clears runs). Now each tab has its own run, so different sites sign in side by side. Only a second tab for the same site waits and retries every 5 seconds, and closing a tab ends its run.
- **What it saw.** The background keeps the last 30 decisions (site, page, action and the reason for any wait or skip; the URL's host and path only) in `storage.session`, and the popup shows them.
- **Slack only:** the ✓/✗ badge, the stale-token reload at 2 minutes, and the desktop-prompt and landing redirects.

## Key design decisions

### 1. Skip the workspace form

`https://acme.slack.com/` goes straight to the sign-in options; the bookmark test confirmed it. So on the picker, the extension calls `location.replace()` with that URL instead of typing. There's no React input to deal with, and the target is a freshly loaded page, so its crumb is valid. It fires on the bare picker as well as on Slack's sign-out's `redir=…teams=T0123ABCD`. It only leaves the picker alone when the `redir` names other workspaces.

The original `redir` isn't passed along. It points at whichever channel I happened to be in when I was signed out, and I'd rather always land on my chosen channel (decision 4).

Filling in the form is dropped from v1. It's only worth building if Slack ever stops the team URL from working.

### 2. Reload stale Slack pages before acting, except the MFA page

Before clicking on the picker or the sign-in options page, check how long ago the page loaded (`Date.now() - performance.timeOrigin`). If it was more than ~2 minutes ago, call `location.reload()` and let the reloaded page carry on. A reloaded page is fresh, so this can't loop.

The MFA page is never reloaded, because that would throw away the progress so far and start the sign-in again.

### 3. Only run when I'm looking at the tab

The sign-out often happens while I'm away. If the extension ran through straight away, the Google and MFA pages would sit there and go stale. So the automation starts only when the tab is **visible** (on load if already visible, otherwise on `visibilitychange`). Together with #2, the flow is: I come back to the tab, it reloads, runs through the steps and stops for my input.

To sign in on demand, open the site from the popup's site list. Opening a site while signed out starts its sign-in. (A "Sign in now" button and an `Alt+Shift+S` shortcut for Slack were removed on 2026-10-16 as redundant.)

### 4. Land on my channel and skip the desktop-app prompt

After MFA, Slack sends the tab to `/ssb/redirect`, which tries to open the desktop app through a `slack://` link. That link is what makes Chrome show "Open Slack?".

A `declarativeNetRequest` rule redirects any top-level request for `https://acme.slack.com/ssb/redirect*` to the landing channel before the page loads, so the prompt never appears. It's a dynamic rule, so the options page can change the channel or switch the rule off. The rule also applies when I sign in by hand, which is fine since I always click Cancel anyway.

Verified 2026-10-16: skipping `/ssb/redirect` doesn't skip anything the sign-in needs. After MFA the tab lands signed in on the channel, with no prompt.

### 5. One run, tracked by the service worker

The flow crosses two origins, so run state lives in the background service worker (`chrome.storage.session`, which is cleared when Chrome restarts).

The content script is deliberately simple and knows nothing about any site. It asks the background which elements to look for on this site (from its definition in `src/sites/`), then reports which are present, the URL, whether the tab is visible, the page's age and whether the URL has settled. The site's `classify()` says which step that is, `src/lib/engine.js` decides what to do, and the background sends back a single action. All the decisions sit in one module with no `chrome.*` calls, which is what makes them unit-testable. It also means the content script never needs direct `storage.session` access, which would require `setAccessLevel`.

## States

`IDLE → SLACK_PICKER → SLACK_SIGNIN → GOOGLE_CHOOSER → GOOGLE_PASSWORD → GOOGLE_CONSENT → SLACK_MFA → DONE`

- `GOOGLE_PASSWORD` is skipped when Google's session is still live. It's a waiting-for-me state, so the run window stretches to 10 minutes.
- `SLACK_MFA` focuses the first input and then ends the run as `DONE`. From there the redirect rule takes care of the landing page by itself.
- `PAUSED`: the loop guard tripped, or the extension landed on a page it doesn't expect.
- `ERROR`: a selector timed out.
- If a run expires before reaching `SLACK_MFA`, the background sends a notification naming the last step reached. This catches Google moving a page to a URL the content script doesn't match, which would otherwise fail silently.

Each step waits for its element (MutationObserver with a 10s timeout), acts, and reports back to the background. On a timeout the run moves to `ERROR`, a notification names the step that failed, and nothing else gets clicked.

## Project layout

```
auto-sign-in/
├── manifest.json
├── src/
│   ├── background.js          # run state, badge, notifications, run log, alarms, the sites' redirect rules
│   ├── lib/
│   │   ├── config.js          # timings, default settings
│   │   ├── steps.js           # the steps a run moves through
│   │   ├── recording.js       # a recording, and the site entry it becomes
│   │   └── engine.js          # every shared decision: runs, Google's pages, loop guard, signed-in status
│   ├── config/                # the config format (schema.js: checks and defaults) and storage (store.js)
│   ├── sites/                 # sites are built from the config: no site is hard-coded
│   │   ├── types/             # button (one button or a few steps, then Google), slack, google
│   │   ├── presets.js         # the built-ins a config names by preset: Google and Slack
│   │   ├── build.js           # config → site definitions → registry
│   │   └── registry.js        # lookups by id and URL, host access per site
│   ├── content/
│   │   ├── recorder.js, locate.js  # Record a site: the bar, and how a recorded element is found again
│   │   ├── selectors.js       # Google's selectors and page text, shared by every site
│   │   ├── dom.js             # waitFor(), first(), accountRow(), buttonWithText(), press(), setValue(), onAutofilled()
│   │   └── agent.js           # generic: reports the page, carries out the one action it gets back
│   ├── popup/                 # on/off, dry run, site links, last-10-runs log, what it saw
│   └── options/               # Google account email, sites (on/off, add, edit, remove), quick links, landing pages, config import/export
├── test/                      # engine, site and DOM tests (test/run.html); e2e/ end-to-end test with mock pages
├── scripts/                   # test.sh and e2e.sh (headless Brave), make-icons.py
├── docs/selectors.md          # recon notes: URL sequences, DOM snippets, chosen selectors
├── README.md
└── PLAN.md
```

There's no bundler and no npm dependencies. It's plain JS that Chrome loads directly. The background worker, popup and options page are ES modules sharing `src/lib/` and `src/sites/`. The content-script files are classic scripts that share globals: `manifest.json` lists `selectors.js` and `dom.js` before `agent.js`.

`manifest.json` itself holds the permissions (`storage`, `notifications`, `alarms`, `declarativeNetRequestWithHostAccess`, `browsingData`) and the content-script `matches`.

## Implementation notes

- **Page detection on `acme.slack.com`.** Detect by DOM, not URL. The Google button present means the sign-in options page. `input[autocomplete="one-time-password"]` present means the MFA page. Neither means do nothing, because lots of other pages live on this domain.
- **Selector priority.** Prefer `data-qa` attributes (Slack uses them widely). Next come `id`, `name`, `type`, `autocomplete` and `aria-label`, then matching on visible text. Never use generated class names. Confirmed selectors go in `docs/selectors.md`.
- **Slack's Google button.** `[data-qa="base_google_login_button"]`, with `#google_login_button` as the fallback. It's a `type="button"` with a loading state, so click it once and record that it was clicked. Otherwise a later DOM change could trigger a second click.
- **Google account chooser.**
  - First confirm the sign-in is for Slack. Either the URL's parameters contain `slack.com`, or the page says "to continue to Slack". The URL is the main check; don't rely on page text alone.
  - Then find the element whose text is exactly the configured email, go up to its clickable ancestor (`[data-identifier]`, `[role=link]` or `li`) and click it.
  - Never click "Use another account".
- **Google password.** Switch to `WAITING_FOR_USER`, focus the field, and send a notification if the tab is hidden. Never fill anything in.
  - `dom.js` `onAutofilled` counts any of these as a fill:
    - an untrusted input event that changed the value (another extension, such as a password manager, simulating keystrokes);
    - more than one character added in one change (an autofill or a paste);
    - a change with no event at all (caught by polling);
    - 6 or more characters arriving under 30ms apart.
  - Once the box has been unchanged for 400ms, click Next, once per page.
  - A person typing produces trusted events, one character at a time and far slower, so a typed password is never submitted. A trusted edit after a fill means I've taken over, so the extension stands down.
  - The first version only looked for several characters arriving at once. It missed password managers that simulate typing one character at a time (2026-10-16).
- **Google consent (`/signin/oauth/id`).** Click the `button` whose text is "Continue".
- **MFA handoff.** Detect `input[autocomplete="one-time-password"]` (fallback `.two_factor_input_item input`). Focus `[aria-label="digit 1 of 6"]`, or the first input if that label isn't there. Set the badge to "MFA" and end the run.
- **Desktop-prompt rule.** A dynamic DNR rule set on install and whenever the options change:
  ```json
  {
    "id": 1,
    "priority": 1,
    "action": { "type": "redirect", "redirect": { "url": "https://app.slack.com/client/T0123ABCD/C0123ABCD" } },
    "condition": { "urlFilter": "|https://acme.slack.com/ssb/redirect", "resourceTypes": ["main_frame"] }
  }
  ```
- **Signed-in badge (added 2026-10-16).** When no run badge applies, the badge shows ✓ (signed in) or a grey ✗ (signed out). It reflects the last Slack page seen:
  - Any of this workspace's sign-in pages sets "out" (in `engine.js`, even when switched off).
  - The Slack client page (`app.slack.com/client/T0123ABCD…`) sets "in" once it has settled, meaning it's still there after 3 seconds. A signed-out client redirects to the sign-in page at once, so it never gets that far.
  - Signing in clears any leftover run badge.
  - It doesn't read cookies or poll Slack, so with every Slack tab closed it keeps the last status.
- **Synthetic clicks.** `el.click()` dispatches events with `isTrusted: false`. Slack shouldn't mind, and Google usually doesn't. If Google does reject them, the fallback is to focus the button and send a notification asking me to press Enter. That's still one keypress instead of the whole flow. Avoid `chrome.debugger`: it shows a warning bar and is more than this needs.
- **Dry-run mode.** Instead of clicking, outline the target element in red and log what would have happened. This is essential for checking each step and for diagnosing breakage when Slack or Google change their UI. Dry-run doesn't affect the redirect rule, which has its own toggle.

## Phases

### Phase 0: Recon (mostly done, 2026-10-16)

Done: the URL sequence, same-tab behaviour, Slack's Google button, the MFA inputs, the desktop-prompt page, the landing channel, and confirmation that Google didn't ask for its own 2-Step code.

Left over: the outerHTML of the account row on the chooser and of Continue on `/signin/oauth/id`. Text matching covers both, so these are nice to have. Grab them next time I'm signed out.

### Phase 1: Skeleton and the redirect rule

**Done 2026-10-16.**

Build the manifest, the background script with run state and loop guard, the popup and the options page. Load it unpacked in Chrome: `chrome://extensions` → Developer mode → Load unpacked.

Ship the redirect rule first. It works independently of everything else, removes the most annoying step, and can be tested at the next sign-out.

Add unit tests for page classification, the loop guard and the run window.

### Phase 2: Slack side

**Done 2026-10-16.** Covered by the e2e test against mock pages.

Implement the picker redirect, the Google button click (with the staleness and visibility checks) and the MFA handoff. Check each step in dry-run before going live.

### Phase 3: Google side

**Done 2026-10-16.** The e2e test covers the chooser, password and consent pages. The edge pages (Verify, email, 2-Step) are built but have only unit tests, because none has appeared in the real Slack flow yet.

Implement the chooser click with the Slack check, the password wait and the consent Continue. Add the edge pages (Verify, the email page and 2-Step) as tolerated branches.

### Phase 4: Hardening and a week of real use

**In progress.** The error notifications, run-expiry notification and popup log are built.

First real-page testing (2026-10-16):

- The clicks work on Slack's and Google's real pages.
- The redirect rule works.
- Testing several sign-ins in a row tripped the loop guard even though every run reached MFA, so a run that reaches MFA now resets the count.
- Pressing Back mid-run starts a fresh run, as intended.
- Added at my request: Next is clicked on Google's password page after a password manager fills it.

Still to do: a week of unattended sign-outs by Slack.

- Error notifications that name the failed step.
- The run-expiry notification.
- A popup log of the last 10 runs: which step each one reached and how long it took.

Then use it through a week of real sign-outs and fix whatever breaks.

## Testing without waiting to be signed out

- Sign out from Slack's menu in the browser, which lands on the sign-in flow. Or open Slack from the popup's site list.
- Run every new step in dry-run first.
- To test the Google password branch, Google's own session has to have lapsed. Either test first thing in the morning, or use a second Chrome profile that's signed out of Google, with the extension loaded there too.
- To test the stale page, load the sign-in options page, leave the tab hidden for 30+ minutes and then come back to it.
- Run `scripts/test.sh` for the engine, rules and DOM tests, and `scripts/e2e.sh` for the whole extension against mock pages. Both use headless Brave and the system `python3`, because this machine has no Node.

## Risks

| Risk | Mitigation |
|---|---|
| A site or Google changes its UI and breaks selectors | Each site's selectors live in its definition in `src/sites/`, Google's in `src/content/selectors.js`; failures name the step; dry-run plus Claude in Chrome to redo the recon |
| Google moves a sign-in page to a new URL | The run-expiry notification names the last step reached; widen the `matches` |
| A runaway loop gets the account locked | Loop guard (3 runs per 15 min), per-step timeouts, run window |
| Google ignores synthetic clicks | Focus the button and ask me to press Enter |
| The Google script acts on sign-ins for other sites | Runs only on sign-in paths, only during a run, and only after the Slack check on the chooser |
| Skipping `/ssb/redirect` breaks sign-in | Switch the rule off in options and go back to clicking Cancel by hand |
| Slack stops accepting the bare team URL from the picker | Build the form-filling fallback |

## Where the Claude browser extension fits

- **Recon.** Most of it was done by hand in DevTools. Claude in Chrome is handy for re-checking pages when something breaks.
- **Fallback.** If a Slack UI change breaks the extension, asking Claude in Chrome to "sign me into acme Slack and stop at the MFA prompt" gets me in that day while the selectors are fixed.
- **Not the main solution.** A deterministic extension is instant and doesn't depend on an LLM. It also avoids putting an AI agent in the sign-in path every day.

## Answered questions

- The MFA prompt is Slack's own: six single-digit inputs on `acme.slack.com/`.
- Only one Google account (the work one) is signed in to Chrome, but Google still shows its account chooser.
- Google opens in the same tab.
- Google asked for a password (its session had lapsed) but not for its own 2-Step code.
- My employer's IT doesn't manage Chrome, so nothing should stop an unpacked extension from loading.
- After sign-in I want to land on `https://app.slack.com/client/T0123ABCD/C0123ABCD`, and I always cancel the desktop-app prompt. The redirect rule does both (confirmed 2026-10-16).
- I fill the Google password with a password manager, and want Next clicked after it fills.
