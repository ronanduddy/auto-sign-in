# Design: sites as data, added by recording

*Written 2026-10-16, and kept current. The history at the end says how it got here.*

## Why

The extension began as one person's Slack sign-in, with every site's hosts, selectors and IDs in the code. Turning the sites into the user's own data gives two things:

- Anyone can add a site, without touching code, by recording one sign-in.
- The code can be public: it names no company, no site and no product beyond Slack and Google, which it handles itself.

## 1. Site types; the config holds the sites

The code keeps three site types. Each is a factory: it takes plain config and returns the site definition the engine uses (`matches`, `elements`, `classify`, `google`, `rules`).

| Type | Flow | Where it comes from |
|---|---|---|
| `button` | The site's own sign-in steps (one button, or a few: see section 6), then Google, then optionally the site's own code page, where it hands over to you | Recorded in the options, or written in a config file |
| `slack` | Workspace picker, Google, MFA hand-over, then (separate settings) skipping the "Open Slack?" prompt and opening a chosen page instead of the default view | Built in: the options' Slack section (workspace, team ID) |
| `google` | Google's own sign-in, and landing on Gmail instead of Google's account page | Built in, always there; disable it to switch it off |

A config names the built-ins by preset: `{ "preset": "google" }`, `{ "preset": "slack", "workspace": "acme", "teamId": "T0123ABCD" }`. No product presets ship: every other site is recorded (or written by hand), so the code doesn't reveal which tools anyone uses.

## 2. The config

A versioned JSON document in `chrome.storage.local`, checked on load and on import, and exportable as a file. `config/example.json` has one site of each kind:

```json
{
  "version": 1,
  "quickLinks": [{ "label": "New Google Meet", "url": "https://meet.google.com/new" }],
  "sites": [
    { "preset": "google" },
    { "preset": "slack", "workspace": "acme", "teamId": "T0123ABCD" },
    {
      "id": "dashboard",
      "label": "Dashboard",
      "labels": ["requires VPN"],
      "type": "button",
      "host": "dashboard.example.com",
      "signIn": { "path": "/login", "button": { "texts": ["Sign in with Google"] } }
    }
  ]
}
```

- **Labels** are any number of short tags shown beside a site ("requires VPN", "staging").
- **Quick links** appear at the top of the popup; "New Google Meet" is the default.
- **Personal settings stay out of the config:** your Google email, dry run, Slack's prompt and landing page. So a config file can be shared without anyone's details in it.
- **No code or regular expressions in config.** App names are case-insensitive text, and selectors are checked when saved or imported.

## 3. Permissions: access granted per site

A Manifest V3 extension's permission list is fixed when it's built, so:

- **The manifest's own access** is only `accounts.google.com` and `myaccount.google.com`. It has `optional_host_permissions: ["https://*/*"]`, `scripting`, and `activeTab` (for the recorder; see section 6).
- **Access is granted per site,** in the click that saves or imports it (`chrome.permissions.request`). Removing a site gives back access no other site uses.
- **Recording asks for access to all sites, for the recording only** (unless you untick "Follow the sign-in to other sites"), so the recorder can follow a sign-in onto any host. It's given back (`chrome.permissions.remove`) when the recording is done or cancelled or its tab closes; saving the site asks for its own hosts.
- **Content scripts are registered at runtime** for the granted sites (`chrome.scripting.registerContentScripts`), again whenever the config or the granted access changes. Google's script stays in the manifest.
- **One state per site: enabled or disabled.** Every site is enabled unless it's disabled in the options (kept in the settings' `disabledSites`) or its access is missing. **Disable** switches it off and gives back its access, unless another enabled site uses the same addresses; **Enable** asks for the access again. The popup marks only disabled sites.

## 4. The engine takes its sites as an input

`decide()` and the other engine functions take a registry of sites, which the background builds from the config whenever it changes. The tests pass in their own example sites (`test/sites.json`). The run model, Google's steps, the loop guard and "What it saw" don't depend on any particular site.

## 5. Options and popup

- **Sites:** an alphabetical list with on/off boxes, Edit and Remove. A recorded site opens as its list of steps; anything the list can't show in full (SAML, several verification pages, its own address patterns) opens as JSON. Google itself has only its box; Slack's Edit goes to its own section. Changes save straight away.
- **Record a site…** is the way to add one (section 6).
- **Duplicate** copies a site for another copy of it (staging, training): you change its addresses, one box per host it uses, and every place they appear follows (host, steps, home page, address patterns, Google check, links in selectors; whole hosts only). The name follows the first address, environment included, until you type one.
- **Slack:** workspace and team ID (in the config), and two separate personal switches, each a redirect rule: skip the "Open Slack?" prompt, and open a chosen page instead of the workspace's default view.
- **Quick links,** the Google options, and a **Config file** section for import (with a review of every site and host) and export.
- **Popup:** quick links, the sites with their labels, "disabled" on any disabled site, and a recording in progress.

## 6. Sign-in flows, and the recorder that writes them

**Steps are page rules, not a recording replayed.** A `button` site lists `steps` (or one `signIn`, the one-step case):

```json
"steps": [
  { "path": "/", "click": { "texts": ["Log in"] } },
  { "host": "auth.example.com", "path": "/login", "email": {}, "click": { "texts": ["Continue"] } },
  { "host": "auth.example.com", "path": "/sso", "click": { "texts": ["Continue with Google"] } }
]
```

- Each step is a rule: on a page whose address starts with `path` (on `host`, if given), when its element shows, do one thing.
- **Only three actions:** click a button or link; fill in your Google email and then click; or hand over to you (the `handover` pages).
- **Judged from the page.** A step that doesn't come up (say the site remembers your email) is skipped, and a run can start at any step.
- **Each step at most once per run.** Coming back to a step already done means the sign-in went round in a circle: a new attempt, which the loop guard counts.
- **Never secrets.** The email step types only the email from your settings, and never into a password box.
- **Second hosts come with the steps.** A step's `host` joins the site's pages, its access and Google's address check, and pages there never count as signed in.

**The recorder** writes the steps by watching you sign in once:
1. Options → **Record a site…**: an address, and optionally a name (otherwise it's taken from the address, with any environment it names: `app.acme.com` would be "Acme", `acme-training.example.com` "Acme (training)"). The click grants access to that host. A tab opens with a bar.
2. **Clicks** on the site's pages become click steps: the page's path, the element's text, and a selector only from stable attributes (an id, a name, a link or form address, a test id). Its position on the page is a last resort, marked fragile.
3. **An email box** on the site gets your Google email from the options as soon as it shows, so there's nothing to type: the extension only ever signs in with that account. A click in the box's form then becomes "fill in your email, then click …". A box you or your password manager filled counts too. The recorder only checks whether a box is empty, never what's in it.
4. **A password or code box** on the site becomes a hand-over there; the bar says so.
5. **Google's pages are left to you and only noted:** whether Google's address names the site's host, and otherwise the app name from "to continue to …". That includes Google's pages in a pop-up window the recording tab opened, and Google pages its content script doesn't run on (noted from the tab's address).
6. **Other hosts** (a login domain, or the app on its own domain once signed in) get the recorder as soon as the tab loads them, thanks to the recording's access to all sites. Without it, the popup offers "Record on … too" (a permission prompt needs a click in the extension's own pages). Google's pages show a banner instead of the bar: it names the single sign-on ("for Acme", from Google's "to continue to …"), and says every sign-in does that part itself.
   - *Changed 2026-10-16:* at first the recorder only had the address you gave, and on any other host it silently had no bar and no Done button. A real sign-in that moved to another domain after Google couldn't be finished, and one that went through Google looked as if the recorder had stopped.
7. **Done, I'm signed in** (in the bar, or in the popup): where you are becomes the site's home page, even on another host, and that host joins the site so sign-ins can tell they've finished there. The options page shows the steps for review, marking steps after Google and fragile ones, and warning when nothing was clicked, when pages were missed, or when Google's pages weren't seen. That last one is normal when you're already signed in to Google and have used the site before: Google then sends you straight back without showing a page. The recorded steps still work, and when Google does show its pages on a later sign-in, the built-in Google steps handle them. Remove stray clicks, then **Save site**.

**Out of scope:** passwords or codes typed on the site (those are hand-overs), CAPTCHAs, any text other than your email, and Google's own embedded buttons (One Tap, Google's "Sign in with Google" frame).

**Open question (not seen on a real site so far):** sites whose Google sign-in opens in a pop-up window. A run follows one tab, so the pop-up has no run of its own. If Google's address there doesn't show an app (only an opaque `continue`), the Google loop may treat it as a sign-in to Google itself and pick your account, which makes such sites work but for the wrong reason. Treating a pop-up opened by a tab with a run as part of that run would be the proper fix.

## Guardrail: imported sites are reviewed

A config file is only data, but a malicious or mistaken one could point a site at a host that runs its own "Sign in with Google". The extension would then pick your account and click **Allow**, granting that app access to your Google account. So importing a file shows every site and host before anything is saved or any access is asked for. `SECURITY.md` should say that this review is the defence.

(Versions 0.4 to 0.7 also asked you to approve each app on its first Continue/Allow. That was removed as not needed: sites come from your own recordings, or from a file you've reviewed. The extension deletes any stored approvals when it's reloaded.)

## Testing

- **Unit tests** (`test/run.html`, in headless Brave): the engine, site types, config checks, the recorder's element descriptions and recordings, and the options' helpers, all against made-up sites on example hosts (`test/sites.json`).
- **End to end** (`test/e2e/run.py`): the real extension against mock pages on example hosts, signing in through each kind of site, including a multi-step site on two hosts; recording that site through the options page with real clicks and typing, then signing in with the recording; the popup; and the options page's editing and Slack settings.

## Risks

| Risk | Mitigation |
|---|---|
| Permission prompts for every site | One prompt per record, save or import, covering all its hosts |
| Content scripts registered at runtime drift from the config or the granted access | Re-register on every config or permission change and on startup, with an end-to-end check |
| A config file that points at a hostile site | A review screen on import showing every site and host; no code or regexes in config |
| A recorded or shared flow clicks something it shouldn't | Steps act only on the site's own pages during a run, with three actions, each once per run; recordings are reviewed as a step list; the loop guard still applies |
| Recorded selectors are brittle | Prefer the element's text; keep a selector only when it's stable; dry run to check; record again when a site changes |

## Decisions (2026-10-16)

1. **No shared company config.** Everyone records their own sites. A config file can still be exported and imported, for a backup or to share by hand; the extension never fetches one.
2. **Storage:** the config stays on one machine (`chrome.storage.local`); nothing syncs.
3. **Distribution:** "load unpacked" only, with no Chrome Web Store listing. Licence and project name are still to choose.
4. **SAML** sign-ins stay a documented option of the `button` type (see "Internal app" in `config/example.json`).

## History (all 2026-10-16)

1. The engine took its sites as an input instead of a fixed list.
2. Site types, presets and the config, with import and export.
3. Host access granted at runtime, and content scripts registered at runtime.
4. The options page's site editor and quick links.
5. Sign-in steps (5a), and the recorder with a step list for review (5b). Recording then replaced the product presets and the "custom sign-in button" form, and Slack got its own options section. The first-sign-in app approval was removed.
6. Everything specific to one company or its tools left the code, tests and docs. The tests run against made-up sites on example hosts.

7. Ready to publish as `auto-sign-in` under the MIT License, with `CONTRIBUTING.md` and `SECURITY.md`. The public repository starts from a single first commit, so none of the earlier history (which had the original company's sites) goes with it.
