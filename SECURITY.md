# Security

Auto sign-in clicks through sign-in pages on your behalf, so it's built to do as little as it can, and never to touch a secret.

## What it never does

- **Read, store or fill in a password or a verification code.** On Google's password page it waits for you. The one thing it submits there is a password your password manager filled in, and it decides that from the length of what's in the box and the input events, never the password itself. It does this at most once per page, and you can switch it off. On Google's 2-Step page it clicks Next once a 6-digit code has stopped changing, again without reading it.
- **Read or store cookies or tokens.** "Sign out of all" deletes the sites' cookies through the browser's `browsingData` API, without reading them.
- **Record what you type.** While recording a site, it notes where you click and which boxes are email, password or code boxes, and checks only whether a box is empty. The only value it ever puts in a box is the Google email you set in the options.
- **Fetch anything.** It never downloads configuration or code, and never checks on a site in the background. It only acts on pages you open.

## What it can access

- **Its own permissions:** `storage`, `notifications`, `alarms`, `declarativeNetRequestWithHostAccess`, `browsingData` (for "Sign out of all"), `scripting` (to run its page script on the sites you add) and `activeTab` (so the popup can see which site a recording has moved on to).
- **Hosts:** the manifest covers only `accounts.google.com` and `myaccount.google.com`. Every other site's access is asked for when you record, save or import it, and given back when you disable or remove it.
- **While recording,** it asks for access to all sites, so the recorder can follow a sign-in onto other hosts. That access is given back when the recording is done or cancelled, or its tab is closed. You can untick "Follow the sign-in to other sites" to record with access to one site only.

## Safeguards

- **It acts only during a sign-in it started**, on the site's own pages and on Google's sign-in pages, and on Google only once Google's page shows the sign-in is for that site. Signing in to anything else is left alone.
- **Steps are limited.** A recorded or written step can click, fill in your Google email and click, or hand over to you. Nothing else, and each at most once per sign-in.
- **Loop guard.** At most 3 automatic sign-ins per site in 15 minutes; then it pauses that site and tells you.
- **One sign-in per site at a time,** each in its own tab.

## Config files

A config file is only data (addresses, button text, CSS selectors), with no code and no regular expressions. But a malicious or mistaken one could point a site at a host that runs its own "Sign in with Google": the extension would pick your account and click **Allow**, granting that app access to your Google account.

**Only import config files from people you trust.** Importing shows every site and host in the file before anything is saved and before any access is asked for. That review is the defence, so read it.

## Reporting a vulnerability

Please report security problems privately, through this repository's **Security** tab (Report a vulnerability), rather than in a public issue. Include what you saw and how to reproduce it.
