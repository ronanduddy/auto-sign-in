# Auto sign-in

A Chrome extension that signs you back in to the sites that keep signing you out, as long as they sign in through Google. You add a site by **recording** one sign-in: the extension notes the steps, then repeats them whenever the site shows its sign-in page. For each site, it clicks through to Google, picks your account, and either waits for you where a secret is needed or finishes the job.

| Site | It clicks | It hands over at |
|---|---|---|
| **Google** itself (built in) | Google's own account chooser (e.g. Gmail asking you to sign in again) → your account | Nothing: done when Google sends the tab on, then straight on to Gmail, instead of Google's account page, when you signed in with nowhere else to go (an option). Never clicks Continue/Allow |
| **Slack** (built in: your workspace) | Workspace picker → sign-in page (no typing) → Google button → your account → Continue | Slack's MFA code. Then, as separate options, it skips the "Open Slack?" prompt and opens your chosen channel |
| **Any site you record** | What you clicked when you recorded it (a "Log in" link, your email then Continue, a "Sign in with Google" button…) → your account → Continue/Allow | The site's own code or password box, if you recorded one; otherwise nothing: done when the site loads |

Every site's flow goes through Google's sign-in steps as part of its own run, so the Google loop is only needed when you land on Google's sign-in directly; it's often the first thing to do in the morning, since everything else depends on the Google session.

On every site, Google's password page (when Google's own session has lapsed) is mine to fill. On Google's 2-Step page, the extension ticks "Don't ask again on this device" and focuses the code box. Once the 6-digit code is in (typed, or filled by your password manager), it clicks Next. Backup codes and 2-Step pages without a code box are left to you, and an option turns this off. When your password manager fills Google's password box, the extension clicks Next.

It never reads, stores or fills in a password or MFA code. The one thing it submits is Google's password page, and only in a narrow case:

- It clicks Next only when something other than your keystrokes filled the box: a password manager or a paste. Your real keystrokes are marked as trusted by the browser, and a password manager's simulated ones aren't.
- It never reads the password itself, only the length of what's in the box and the input events.
- A password you type is left for you to submit with Enter, and typing over a fill hands the box back to you.
- It does this at most once per page, and you can switch it off in the options.

See [PLAN.md](PLAN.md) for the design and its guardrails.

## Install (Chrome)

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose this folder (the one containing `manifest.json`).
3. The options page opens. Enter your Google account email and save.
4. Add your sites with **Record a site…** (see [Adding a site](#adding-a-site-a-new-loop)). Chrome asks to let the extension read and change each one: that's the access it needs to click its sign-in steps.
   - If you use Slack, fill in its section: the workspace and team ID, and whether to skip the "Open Slack?" prompt and which page to open instead of the workspace's default view. These are separate settings.
   - Or, if someone has shared a config file with you, import it under **Config file** at the bottom. You see every site and host in it before anything is saved.
   - Every site starts enabled when it's added (recorded, duplicated or imported); disabling is the exception. **Disable** any you don't want it to sign in to (that also gives back the extension's access to it), and **Enable** to bring it back. Each site's address links to it.
5. Optional: pin the extension to the toolbar (the puzzle-piece menu), so the badge is visible.

After pulling changes, click the reload icon on the extension's card in `chrome://extensions`.

It's a Chrome extension, so it works the same in other Chromium browsers (Chrome, Edge): load it from their own extensions page.

## Using it

There's nothing to do day to day. When a site shows its sign-in page, the extension starts as soon as you look at the tab. Sign-ins to different sites go ahead side by side, one per tab. A second tab for the same site waits its turn, and a closed tab's sign-in is dropped.

- **Toolbar badge:**
  - `…` while signing in.
  - `PW` while waiting for your Google password.
  - `MFA` once a site's code box is ready (Slack's, or a recorded site's).
  - `!` when something went wrong.
  - Otherwise, `✓` when you're signed in to Slack and a grey `✗` when you're signed out. Those come from the last Slack page you had open. Nothing checks with Slack in the background, and no cookies are read.
- **A banner on the page** for the whole of an automatic sign-in, from the site's sign-in through Google's pages: "Auto sign-in: signing in to Acme · Google's account chooser…", or "…waiting for you on Google's password page". At the end it says "signed in to Acme", "over to you on …" where a code is needed, or that it stopped. None of them stays: a step's banner goes after 2 seconds, "signed in" after 6, and the ones waiting for you as soon as you type or click (or after 30 to 60 seconds). Clicks go through it.
- **Notifications:** sent when it needs you and the tab isn't in front, and when a run stops or fails, naming the site and step.
- **Popup:**
  - An on/off switch.
  - **Dry run**, which outlines in red what it would click instead of clicking.
  - **New Google Meet:** a link that starts a new meeting (`https://meet.google.com/new`) in a new tab.
  - **Sites:** a link to each site, in alphabetical order, opening in a new tab. Opening one while you're signed out starts its sign-in. Disabled sites say "disabled" (enabled ones say nothing), and a site's labels (such as "requires VPN") show beside it.
  - **Sign out of all:** after a confirmation, signs you out of every site by clearing their cookies, and switches auto sign-in off so nothing signs straight back in. It clears whole domains: all of Google (Gmail included), and all of each site's domain (every `example.com` address for `app.example.com`). The extension never reads the cookies; Chrome's `browsingData` API deletes them.
  - A log of the last 10 runs, with the site for each.
  - **What it saw:** the last 30 sign-in pages it looked at and what it decided, with the reason whenever it waited or did nothing (for example "another tab is signing in to Slack", "waiting for you to look at the tab", "paused after 3 attempts"). It's the first place to look when a site doesn't sign in.
- **Loop guard:** after 3 automatic runs on one site in 15 minutes, it pauses that site and tells you, so a broken step can't hammer Google's sign-in.
  - Runs that sign you in, or reach MFA, reset the count.
  - The `!` clears itself when the site resumes.
  - Reloading the extension clears the pause.


## When it breaks

Sites change their pages. A failure notification names the site and the step it got stuck on, for example "couldn't find Slack's Google button".

1. Open the popup's **What it saw**: it says what the extension made of the page and why it did or didn't act.
1. Switch on **Dry run** and visit the sign-in page to watch what it would do.
2. Inspect the element it should have used, and record the site again (or fix its steps in its JSON). For Google's pages, update `src/content/selectors.js`. Record what changed in [docs/selectors.md](docs/selectors.md).
3. Reload the extension and run the tests.

Some selectors haven't been checked against the live pages yet; [docs/selectors.md](docs/selectors.md) says which. A dry run on each is the quickest check.

## Adding a site (a new loop)

**The quickest way is to record it.** In the options, click **Record a site…** and give its address (and a name, if you like: otherwise it's named after the address, with any environment it names, such as "Acme (staging)"). A new tab opens on the site, with a bar at the bottom. Sign in the way you normally do:
- **Each click** on the site's own pages (a "Log in" link, "Continue with Google") becomes a step.
- **An email box** gets your Google email (from the options) as soon as it shows, so there's nothing to type. Clicking the button in its form then becomes "fill in your email, then click …", and each sign-in does the same. A box your password manager filled counts too. The recorder only checks whether a box is empty, never what's in it.
- **A password or code box** on the site becomes a point where the extension hands over to you.
- **Google's pages** you do by hand as usual; the extension already knows them. On a site's single sign-on through Google ("Choose an account to continue to …"), a banner says so: every sign-in does that part by itself, picking your account and clicking Continue or Allow.
- **Other hosts:** many sign-ins move to another address, such as a login domain, or the app itself on its own domain once you're in. With **Follow the sign-in to other sites** ticked (the default), recording asks for access to all sites, so the recorder follows the tab wherever it goes, and gives that access back when you finish. Saving the site then asks only for the hosts it uses. Unticked, it only has the address you gave; on any other host, click the extension's icon and choose **Record on … too**.
- **Where you click Done** becomes the site's home page, even on another host, so sign-ins can tell they've finished there. The popup has a **Done** button too.

Then click **Done, I'm signed in** in the bar. The options page shows the steps for review: remove any stray clicks (it marks the ones after Google, and any it could only find by their position on the page), then **Save site**. A dry run from the popup shows what it will click.

**Two sites are built in instead of recorded,** because what they do can't be recorded:
- **Google itself** (Gmail, Drive and Google's own sign-in, plus the Gmail landing page): always there; disable it to leave Google's own sign-in alone.
- **Slack:** its own section in the options. Give the workspace (`acme` for acme.slack.com) and its team ID (the T… in the address when it's open at app.slack.com; pasting the whole address works). Two separate switches: skip the "Open Slack?" desktop-app prompt after signing in, and open a page of your choice (a channel, say) instead of the workspace's default view.

No other product is built into the code, so the extension doesn't reveal which tools anyone uses.

**Another copy of a site** (staging, training): click **Duplicate** on the one you have and change its address. Its steps, home page, Google check and any links in its selectors follow the new address, and the name follows too ("Acme (staging)") unless you type your own. If it signs in through other addresses, each has its own box to change.

Sites are config, not code. Each site's **Edit** and **Remove** change it: a recorded site opens as its list of steps, anything else (SAML, several verification pages, its own address patterns) as JSON. Each change saves straight away and asks Chrome for any new access it needs; removing a site gives back access no other site uses. **Export config** saves the result as a file to share.

You can also edit the file itself: add an entry to its `sites` list and import it again. `config/example.json` has one of each kind.

- **The built-ins:** `{ "preset": "google" }`, and `{ "preset": "slack", "workspace": "acme", "teamId": "T0123ABCD" }`.
- **A site with a sign-in button** (`"type": "button"`): give its `host`, the sign-in page's `signIn.path`, and how to find the button (`signIn.button.texts` and/or `selectors`). Optional parts:
  - `handover`: the site's own verification pages, with selectors for the code box.
  - `google.mentions`: text that shows in Google's URL, such as `"saml2"` for a SAML sign-in.
  - `notSignedIn`: paths that never count as signed in.
  - `matches`: the site's pages, if not the whole host.
  - `reloadOnInstall`: sign-in pages that are safe to reload.

  The "Internal app" entry in `config/example.json` shows a SAML sign-in with a two-factor page; `src/config/schema.js` documents every field.
- **A sign-in that takes a few steps** (a "Log in" link first, your email before Continue, a sign-in page on another host): list `steps` instead of `signIn`. Each step is a page and what to do there:
  ```json
  "steps": [
    { "path": "/", "click": { "texts": ["Log in"] } },
    { "host": "login.example.com", "path": "/u/login", "email": {}, "click": { "texts": ["Continue"] } },
    { "host": "login.example.com", "path": "/u/login", "click": { "texts": ["Continue with Google"] } }
  ]
  ```
  - `click` finds a button or link by its whole text and/or `selectors`.
  - `email` fills in your Google email (from the options) before clicking; give `selectors` if the box isn't a usual email box. It never types into a password box.
  - `host` is for a step on another host, such as an identity provider's. That host is added to the site's access.
  - Steps are matched from the page, not replayed in order. One that doesn't come up is skipped, and each runs at most once per sign-in. Coming back to a step already done counts as a new attempt for the loop guard.

  The "Billing portal" entry in `config/example.json` is a full example. In the options, a site with steps shows them as a list you can remove steps from; **Edit as JSON** changes anything else.
- **Labels** are any short text, shown as pills beside the site (`"requires VPN"`, `"staging"`). **Quick links** (`quickLinks`, or the options' Quick links list) appear as buttons at the top of the popup.

No code or manifest change is needed: saving the site, or importing the file, asks Chrome for access to the new site.

## How it works

```
manifest.json
src/
  background.js          service worker: run state, badge, notifications, log, alarms, redirect rules
  lib/config.js          timings and default settings
  lib/steps.js           the steps a run moves through
  lib/engine.js          decides each step (pure, unit-tested): runs, Google's pages, loop guard, status
  config/schema.js       the config format: checks a config file and fills in defaults
  config/store.js        loads and saves the config (chrome.storage.local)
  sites/                 turns the config into sites ("loops")
    types/               button (sign-in button, Google, optional verification pages), slack, google
    presets.js           the two built-ins a config names by preset: google and slack
    build.js  registry.js  config -> site definitions -> the lookups the engine uses
    index.js             the site definition format
  content/selectors.js   Google's selectors and page text (shared by every site)
  content/dom.js         DOM helpers (find, wait, click, fill, detect a password manager's fill)
  content/agent.js       generic: reports what's on the page, carries out the action it gets back
  content/recorder.js    Record a site: the bar, and what you click or type in (never what you type)
  content/locate.js      how a recorded element is found again (its text, stable attributes)
  lib/recording.js       a recording, and the site entry it becomes (pure, unit-tested)
  popup/  options/       toolbar popup and options page
config/                  example.json: a config file with one site of each kind
test/                    engine, site, config and DOM tests (run in a browser page); e2e/ end-to-end
scripts/                 test runners, icon generator
docs/selectors.md        where each site's selectors came from
```

The content script knows nothing about any particular site. On a site's page, it asks the background worker which elements to look for there (from the site definition, built from the config). It then reports which of them are present, plus the URL, whether the tab is visible, how old the page is, and whether the URL has stayed put for 3 seconds ("settled").

The site's `classify()` turns that into a step: redirect, login, hand over or signed in. `engine.js` turns the step into one action, such as `click`, `focus`, `navigate`, `reload` or `noop`, and handles Google's shared pages itself. Run state lives in `chrome.storage.session`, so it's gone when Chrome restarts. Settings and the run log live in `chrome.storage.local`.

Permissions:
- `storage`, `notifications`, `alarms` and `declarativeNetRequestWithHostAccess`.
- `browsingData`, for "Sign out of all".
- `scripting`, so the content script is registered at runtime for exactly the sites you've granted, and the recorder for the site being recorded.
- `activeTab`, so that while recording without access to all sites, the popup can see which host the recording tab has gone on to and offer to record it too.

The manifest itself only has access to `accounts.google.com` and `myaccount.google.com` (for the Gmail redirect). Every other site's access is requested at runtime, when you import a config, record or save a site, or click **Enable** on a disabled one (`optional_host_permissions`); **Disable** gives it back. On a site's pages it only looks for the elements its steps name (by selector, or by a button's or link's text), and it never reads what you type.

## Development

There's no build step and no dependencies. It's developed in Brave, so the tests use headless Brave and the system `python3`, and Node isn't needed. `BROWSER=/path/to/browser` runs them in another Chromium browser. (An organisation-managed Chrome may close itself partway through, because of its policies.)

```sh
scripts/test.sh   # engine, site and DOM tests (test/run.html) in headless Brave
scripts/e2e.sh    # the real extension in headless Brave against mock pages: one scenario per kind of loop
```

- `scripts/e2e.sh` maps every site's hostnames and Google's to a local HTTPS server (see `test/e2e/run.py`), so no sign-in traffic leaves the machine. It loads the extension over the DevTools pipe because Chrome ignores `--load-extension`.
- To watch the unit tests in a normal browser instead, run `python3 -m http.server 8765` and open `http://127.0.0.1:8765/test/run.html`.
- `BROWSER=/path/to/chromium` points either script at another Chromium-based browser.
- `scripts/make-icons.py` regenerates `icons/` (standard library only).

## Performance

It only runs on the sites you add and on Google's sign-in pages; everywhere else it does nothing. On a site's pages, its page script checks whether one of that site's sign-in elements is showing, at most every 300 ms while the page is changing, and only for the elements that belong to that page's path (a step on `/login` costs nothing on a dashboard). The background worker sleeps until a page reports something new.

Measured on a large page that changes ten times a second (3,000 links, buttons and panels): no measurable cost on a site's ordinary pages, and about 2 ms of script time per second (0.2% of one CPU core) when the site has a step recorded on its home page `/`, which applies to every page of the site. Each open tab of your sites does this on its own, and the browser slows the timers of tabs in the background.

## Contributing, security and licence

- [CONTRIBUTING.md](CONTRIBUTING.md): running it, the tests, and the ground rules.
- [SECURITY.md](SECURITY.md): what it can and can't access, its safeguards, and how to report a problem privately.
- Licensed under the [MIT License](LICENSE).
