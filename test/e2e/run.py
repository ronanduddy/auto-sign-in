#!/usr/bin/env python3
"""End-to-end test: the real extension, in headless Brave, against mock sign-in pages.

The browser resolves every site's hosts (Slack, Dashboard, Deploys, Error tracker) and
accounts.google.com to a local HTTPS server that serves the mock pages in pages/. The
script loads this repo as an unpacked extension over the DevTools pipe (Brave ignores
--load-extension), saves the Google email from inside the extension as the options page
would, then runs one scenario per kind of sign-in loop.

Each mock page reports what happened to it by POSTing to /event, and the mock Google pages
pick their next hop from a `flow` query parameter. A scenario ends at its final event, then
checks the extension's own view (the badge, or the run log). Exit status: 0 passed, 1 a
scenario's events were wrong, 2 one timed out, 3 the harness itself failed (for example,
the extension wouldn't load). All these hostnames resolve to the local server, so no
sign-in traffic leaves the machine. Only the standard library is used.
"""
import argparse
import http.server
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, quote, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
PAGES = os.path.join(HERE, "pages")
# Brave, the Chromium browser this is developed in; BROWSER=/path/to/chromium picks another.
DEFAULT_BROWSER = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
DASHBOARD = "dashboard.example.test"
DEPLOYS = "deploys.staging.example.test"
INTERNAL = "internal.example.test"
ACME = "acme.example.test"
ACME_LOGIN = "login.acme.example.test"
HOSTS = (
    "app.slack.com", "example.slack.com", DASHBOARD, DEPLOYS, "errors.example.test", INTERNAL, ACME, ACME_LOGIN,
    "accounts.google.com", "mail.google.com", "myaccount.google.com",
)
# Google's SAML sign-in keeps the app out of its URL; only its own SAML endpoint shows.
SAML_CHOOSER = (
    "https://accounts.google.com/v3/signin/accountchooser?flow=internal"
    "&continue=https%3A%2F%2Faccounts.google.com%2Fo%2Fsaml2%2Fcontinue%3Fidpid%3De2e"
)
EMAIL = "me@example.org"

# A site whose sign-in takes steps (see test/fixture.js, FLOW_ENTRY): "Log in" on the app, the
# email then Continue on an identity provider's host, then its Google button. Added to the
# imported config.
ACME_SITE = {
    "type": "button",
    "id": "acme",
    "label": "Acme",
    "host": ACME,
    "steps": [
        {"path": "/", "click": {"texts": ["Log in"]}},
        {"host": ACME_LOGIN, "path": "/login", "email": {}, "click": {"texts": ["Continue"]}},
        {"host": ACME_LOGIN, "path": "/login", "click": {"texts": ["Continue with Google"]}},
    ],
}


def chooser(flow, redirect_uri):
    return f"https://accounts.google.com/v3/signin/accountchooser?flow={flow}&redirect_uri={quote(redirect_uri, safe='')}"


# Where each site's mock pages and redirects live: (host, path) -> page file, or ("redirect", url).
def route(host, path, query):
    params = parse_qs(query)
    if host == "app.slack.com":
        if path == "/e2e-start":
            return "start.html"
        if path == "/workspace-signin":
            return "picker.html"
        if path.startswith("/client/"):
            return "landing.html"
    if host == "example.slack.com":
        if path == "/":
            # Sign-in options and MFA share this URL in the real flow too.
            return "mfa.html" if params.get("stage") == ["mfa"] else "signin.html"
        if path == "/ssb/redirect":
            return "ssb.html"
    if host == DASHBOARD:
        if path == "/login":
            return "dashboard-login.html"
        if path == "/login/google":
            return ("redirect", "/") if "code" in params else ("redirect", chooser("dashboard", f"https://{DASHBOARD}/login/google"))
        return "dashboard-home.html"
    if host == DEPLOYS:
        if path == "/auth/login":
            return ("redirect", chooser("deploys", f"https://{DEPLOYS}/api/dex/callback"))
        if path == "/auth/callback":
            return ("redirect", "/applications")
        return "deploys.html"  # a single-page app: it routes to /login itself
    if host == "errors.example.test":
        if path == "/auth/login/":
            return "errors-login.html"
        if path == "/identity/login/google/":
            return ("redirect", chooser("errors", "https://errors.example.test/auth/sso/"))
        if path == "/auth/sso/":
            return ("redirect", "/auth/2fa/")
        if path == "/auth/2fa/":
            return "errors-2fa.html"
    if host == INTERNAL:
        if path == "/portal":
            return "internal-login.html"
        if path == "/portal/auth/saml":  # the Sign in form posts here
            return ("redirect", SAML_CHOOSER)
        if path == "/portal/auth/saml/callback":
            return ("redirect", "/portal/mfa/method/new")
        if path == "/portal/mfa/method/new":
            return "internal-2fa.html"
    if host == ACME:
        return "acme-home.html" if path == "/" else "acme-projects.html"
    if host == ACME_LOGIN:
        if path == "/login":
            return "acme-login.html"
        if path == "/oauth/callback":
            return ("redirect", f"https://{ACME}/projects")
    if host == "mail.google.com":
        return "gmail.html"
    if host == "myaccount.google.com":
        return "myaccount.html"
    if host == "accounts.google.com":
        if path == "/v3/signin/accountchooser":
            return "chooser.html"
        if path == "/v3/signin/challenge/pwd":
            return "password.html"
        if path == "/v3/signin/challenge/totp":
            return "totp.html"
        if path == "/signin/oauth/id":
            return "consent.html"
        if path == "/signin/oauth/v2/consentsummary":
            return "allow.html"
    return None


ACME_SCENARIO = {
    "name": "Acme, a sign-in in steps: Log in, the email on another host, its Google button, account, Continue",
    "start": f"https://{ACME}/",
    "done": lambda e: e == "acme-projects",
    "check": ("chrome.storage.local.get('log').then(({ log }) => `log:${log[0].site}:${log[0].outcome}`)", 4),
    "expected": [
        "acme-home-loaded",
        "acme-log-in-clicked",
        "acme-login-loaded",
        f"acme-email:{EMAIL}",
        "acme-google-clicked",
        f"account-chosen:{EMAIL}",
        "consent-continued",
        "acme-projects",
        "log:acme:signedIn",
    ],
}

# What the extension should make happen, from each scenario's start page. `done` spots the final
# event; `check` then reads the extension's own view of the run (JS evaluated in its worker).
LATEST_LOG = "chrome.storage.local.get('log').then(({ log }) => `log:${log[0].site}:${log[0].outcome}`)"
SCENARIOS = [
    {
        "name": "Google: its own account chooser, password (a password manager's fill), 2-Step code, on to Gmail",
        "start": "https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail&flow=google",
        "done": lambda e: e == "gmail-home",
        # The run ends once no Google page follows the tab leaving Google (GOOGLE_LEAVE_GRACE_MS).
        "check": (LATEST_LOG, 10),
        "expected": [
            f"account-chosen:{EMAIL}",
            "password-focused",
            "password-submitted",
            "code-focused",
            "code-submitted:remember=true",
            "gmail-home",
            "log:google:signedIn",
        ],
    },
    {
        "name": "Google: the bare account chooser would land on My Account; the redirect rule goes straight to Gmail",
        "start": "https://accounts.google.com/v3/signin/accountchooser?flow=google-account",
        "done": lambda e: e == "gmail-home",
        "check": (LATEST_LOG, 1),
        "expected": [
            f"account-chosen:{EMAIL}",
            "password-focused",
            "password-submitted",
            "gmail-home",
            "log:google:signedIn",
        ],
    },
    {
        "name": "Slack: picker, Google button, account, password, Continue, MFA, landing",
        "start": "https://app.slack.com/e2e-start",
        "done": lambda e: e.startswith("landed") or e == "ssb-loaded",
        "check": ("chrome.action.getBadgeText({}).then((text) => `badge:${text}`)", 4),
        "expected": [
            "picker-loaded",
            "slack-google-clicked",
            f"account-chosen:{EMAIL}",
            "password-focused",
            "password-submitted",
            "consent-continued",
            "mfa-focused",
            "landed:/client/T0123ABCD/C0123ABCD",
            "badge:✓",
        ],
    },
    {
        "name": "Dashboard: Sign in with Google, account, Continue, Allow",
        "start": f"https://{DASHBOARD}/login",
        "done": lambda e: e == "dashboard-home",
        "check": (LATEST_LOG, 4),
        "expected": [
            "dashboard-login-loaded",
            "dashboard-google-clicked",
            f"account-chosen:{EMAIL}",
            "consent-continued",
            "consent-allowed",
            "dashboard-home",
            "log:dashboard:signedIn",
        ],
    },
    {
        "name": "Dry run: a sign-in page left showing is one attempt, not a new one every few seconds",
        "setup": "chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, dryRun: true } }))",
        # A dry run never clicks, so its run would hold "one sign-in at a time" for 2 minutes.
        "teardown": "chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, dryRun: false } })).then(() => chrome.storage.session.set({ runs: {} }))",
        "start": f"https://{DASHBOARD}/login",
        "done": lambda e: e == "dashboard-login-loaded",
        # Long enough for the page to settle (3s) and be re-reported if that were still a bug.
        "check": ("chrome.storage.session.get('starts').then(({ starts }) => `starts:${(starts['dashboard'] ?? []).length}`)", 7),
        "expected": ["dashboard-login-loaded", "starts:1"],
    },
    {
        "name": "Deploys: the app routes to /login, LOG IN VIA GOOGLE, account, Continue",
        "start": f"https://{DEPLOYS}/",
        "done": lambda e: e == "deploys-home",
        "check": (LATEST_LOG, 4),
        "expected": [
            "deploys-login-shown",
            "deploys-google-clicked",
            f"account-chosen:{EMAIL}",
            "consent-continued",
            "deploys-home",
            "log:deploys-staging:signedIn",
        ],
    },
    {
        "name": "Dashboard and Deploys at once, in two tabs: neither waits for the other",
        "start": [f"https://{DASHBOARD}/login", f"https://{DEPLOYS}/"],
        "done": lambda e, seen=set(): seen.add(e) or {"dashboard-home", "deploys-home"} <= seen,
        "check": (
            "chrome.storage.local.get('log').then(({ log }) => "
            "`log:${log.slice(0, 2).map((e) => `${e.site}:${e.outcome}`).sort().join(',')}`)",
            4,
        ),
        "unordered": True,
        "expected": [
            "dashboard-login-loaded",
            "dashboard-google-clicked",
            "deploys-login-shown",
            "deploys-google-clicked",
            f"account-chosen:{EMAIL}",
            f"account-chosen:{EMAIL}",
            "consent-continued",
            "consent-continued",
            "consent-allowed",
            "dashboard-home",
            "deploys-home",
            "log:dashboard:signedIn,deploys-staging:signedIn",
        ],
    },
    {
        "name": "Internal app: Sign in (SAML), account, hand over at two-factor",
        "start": f"https://{INTERNAL}/portal",
        "done": lambda e: e == "internal-2fa-focused",
        "check": (LATEST_LOG, 1),
        "expected": [
            "internal-login-loaded",
            "internal-sign-in-clicked",
            f"account-chosen:{EMAIL}",
            "internal-2fa-focused",
            "log:internal:handedOver",
        ],
    },
    ACME_SCENARIO,
    {
        "name": "Error tracker: Google, account, Continue, hand over at 2FA",
        "start": "https://errors.example.test/auth/login/",
        "done": lambda e: e == "errors-2fa-focused",
        "check": (LATEST_LOG, 1),
        "expected": [
            "errors-login-loaded",
            "errors-google-clicked",
            f"account-chosen:{EMAIL}",
            "consent-continued",
            "errors-2fa-focused",
            "log:errors:handedOver",
        ],
    },
]


def start_server(port, cert_dir, scenario):
    """scenario is a dict the caller swaps per scenario: events, done(), finished."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.serve()

        def serve(self):
            host = (self.headers.get("Host") or "").split(":")[0]
            url = urlsplit(self.path)
            target = route(host, url.path, url.query)
            if target is None:
                self.send_error(404)
                return
            if isinstance(target, tuple):
                self.send_response(302)
                self.send_header("Location", target[1])
                self.end_headers()
                return
            with open(os.path.join(PAGES, target), "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
            if urlsplit(self.path).path != "/event":
                self.serve()  # a form post, such as Internal app's Sign in
                return
            event = body
            scenario["events"].append(event)
            print(f"  {event}", flush=True)
            self.send_response(204)
            self.end_headers()
            if scenario["done"](event):
                scenario["finished"].set()

        def log_message(self, *args):
            pass

    cert, key = os.path.join(cert_dir, "cert.pem"), os.path.join(cert_dir, "key.pem")
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-subj", "/CN=auto-sign-in-e2e", "-keyout", key, "-out", cert],
        check=True,
        capture_output=True,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class DevTools:
    """Chrome DevTools Protocol over --remote-debugging-pipe: NUL-terminated JSON on fds 3 and 4."""

    def __init__(self, to_browser, from_browser):
        self.to_browser = to_browser
        self.from_browser = from_browser
        self.buffer = b""
        self.last_id = 0

    def call(self, method, session_id=None, **params):
        self.last_id += 1
        message = {"id": self.last_id, "method": method, "params": params}
        if session_id:
            message["sessionId"] = session_id
        os.write(self.to_browser, json.dumps(message).encode() + b"\0")
        while True:
            message = self._read()
            if message.get("id") != self.last_id:
                continue  # an event, not our reply
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error'].get('message')}")
            return message.get("result", {})

    def _read(self):
        while b"\0" not in self.buffer:
            chunk = os.read(self.from_browser, 65536)
            if not chunk:
                raise EOFError("the browser closed the DevTools pipe")
            self.buffer += chunk
        raw, self.buffer = self.buffer.split(b"\0", 1)
        return json.loads(raw)


def launch_browser(browser, port, profile, log):
    # The browser reads commands on fd 3 and writes replies on fd 4; sh puts our pipe ends there.
    browser_reads, we_write = os.pipe()
    we_read, browser_writes = os.pipe()
    rules = ", ".join(f"MAP {host} 127.0.0.1:{port}" for host in HOSTS)
    args = [
        "--headless=new",
        "--use-mock-keychain",  # a fresh profile would otherwise wait on a macOS keychain prompt
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        # No component or list downloads: they're noise, and they keep writing to the profile after exit.
        "--disable-background-networking",
        "--disable-component-update",
        f"--user-data-dir={profile}",
        "--remote-debugging-pipe",
        "--enable-unsafe-extension-debugging",
        f"--host-resolver-rules={rules}",
        "--ignore-certificate-errors",
        "about:blank",
    ]
    process = subprocess.Popen(
        ["/bin/sh", "-c", f'exec "$0" "$@" 3<&{browser_reads} 4>&{browser_writes}', browser, *args],
        pass_fds=(browser_reads, browser_writes),
        stdout=log,
        stderr=log,
    )
    os.close(browser_reads)
    os.close(browser_writes)
    return process, DevTools(we_write, we_read)


def in_worker(devtools, extension_id, expression, timeout=10):
    """Evaluate an expression in the extension's service worker and return its (awaited) value."""
    deadline = time.monotonic() + timeout
    while True:
        targets = devtools.call("Target.getTargets")["targetInfos"]
        worker = next(
            (t for t in targets if t["type"] == "service_worker" and t["url"].startswith(f"chrome-extension://{extension_id}/")),
            None,
        )
        if worker:
            break
        if time.monotonic() > deadline:
            raise RuntimeError("the extension's service worker isn't running")
        time.sleep(0.2)
    session = devtools.call("Target.attachToTarget", targetId=worker["targetId"], flatten=True)["sessionId"]
    reply = devtools.call("Runtime.evaluate", session_id=session, expression=expression, awaitPromise=True, returnByValue=True)
    if "exceptionDetails" in reply:
        raise RuntimeError(f"{expression}: {reply['exceptionDetails']}")
    return reply.get("result", {}).get("value")


def test_copy(work):
    """A copy of the extension whose manifest grants every https site up front. Headless Brave can't
    answer a permission prompt; with access already granted, the site content scripts the
    extension registers at runtime still go through the real code path."""
    copy = os.path.join(work, "extension")
    os.makedirs(copy)
    for name in ("src", "icons"):
        shutil.copytree(os.path.join(REPO, name), os.path.join(copy, name))
    with open(os.path.join(REPO, "manifest.json")) as f:
        manifest = json.load(f)
    manifest["host_permissions"] = manifest["host_permissions"] + ["https://*/*"]
    with open(os.path.join(copy, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    return copy


def save_settings(devtools, extension_id, settings):
    """Write settings from inside the extension, as the options page would."""
    in_worker(devtools, extension_id, f"chrome.storage.local.set({json.dumps({'settings': settings})})")


def check_popup(devtools, extension_id):
    """The popup shows its status and every configured site; then "Sign out of all" from it: the
    sites' cookies go, and auto sign-in is switched off."""

    def open_page(url):
        target = devtools.call("Target.createTarget", url=url, newWindow=True)["targetId"]
        return devtools.call("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]

    def value(session, expression):
        reply = devtools.call("Runtime.evaluate", session_id=session, expression=expression, returnByValue=True)
        return reply["result"].get("value")

    dashboard = open_page(f"https://{DASHBOARD}/")
    time.sleep(1.5)
    before = "dashboard_session" in (value(dashboard, "document.cookie") or "")
    popup = open_page(f"chrome-extension://{extension_id}/src/popup/popup.html")
    time.sleep(1)
    status = value(popup, "document.getElementById('status').textContent")
    listed = value(popup, "document.getElementById('sites').children.length")
    value(popup, "document.getElementById('sign-out-all').click(); document.getElementById('sign-out-yes').click(); true")
    time.sleep(2)
    after = "dashboard_session" in (value(dashboard, "document.cookie") or "")
    enabled = in_worker(devtools, extension_id, "chrome.storage.local.get('settings').then(({ settings }) => String(settings.enabled))")
    return [f"status shown: {status != 'Loading…'}", f"sites listed: {listed}", f"cookie before: {before}", f"cookie after: {after}", f"auto sign-in on: {enabled}"]


def check_options_editor(devtools, extension_id):
    """The options page: which view each kind of site opens in (Google itself has none, Slack's
    Edit goes to its own section), Slack's separate settings saved with Save, and a recorded site
    renamed through its step list, then removed. Site changes are saved to the config straight away."""
    target = devtools.call("Target.createTarget", url=f"chrome-extension://{extension_id}/src/options/options.html", newWindow=True)
    page = devtools.call("Target.attachToTarget", targetId=target["targetId"], flatten=True)["sessionId"]

    def value(expression):
        # As a click would: saving asks for a site's access, which needs a user gesture.
        reply = devtools.call(
            "Runtime.evaluate", session_id=page, expression=expression, returnByValue=True, awaitPromise=True, userGesture=True
        )
        if "exceptionDetails" in reply:
            raise RuntimeError(f"options page: {reply['exceptionDetails']}")
        return reply["result"].get("value")

    rows = "document.getElementById('sites').children.length"
    stored = "chrome.storage.local.get('config').then(({ config }) => JSON.stringify(config.sites.find((site) => site.id === 'acme') ?? null))"
    buttons = "(id) => [...document.querySelector(`.site-row[data-site=\"${id}\"]`).querySelectorAll('button')]"
    edit = f"""(id) => {{
      ({buttons})(id).find((button) => button.textContent === 'Edit').click();
      const editor = document.getElementById('site-editor');
      const mode = editor.hidden ? `focus:${{document.activeElement.id}}` : !document.getElementById('editor-json-field').hidden ? 'JSON' : 'steps';
      if (!editor.hidden) document.getElementById('editor-cancel').click();
      return mode;
    }}"""

    # "Sign out of all" (checked just before) switched auto sign-in off, and redirect rules only
    # apply while it's on.
    in_worker(
        devtools,
        extension_id,
        "chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, enabled: true } }))",
    )
    time.sleep(1.5)
    google_buttons = value(f"({buttons})('google').map((button) => button.textContent).join(', ')")
    results = [f"sites listed: {value(rows)}", f"google's buttons: {google_buttons}"]
    for site in ("acme", "internal", "slack"):
        mode = value(f"({edit})('{site}')")
        results.append(f"{site} opens in: {mode}")

    # Slack: the team ID pasted as an address, the prompt left to Slack, the landing page kept.
    fields = "['slackWorkspace', 'slackTeamId', 'skipDesktopPrompt', 'goToSlackLanding'].map((id) => { const el = document.getElementById(id); return el.type === 'checkbox' ? el.checked : el.value; }).join(' ')"
    results.append(f"slack section: {value(fields)}")
    value(
        "document.getElementById('slackTeamId').value = 'https://app.slack.com/client/T0123ABCD/C0123ABCD';"
        "document.getElementById('skipDesktopPrompt').checked = false;"
        "document.getElementById('form').requestSubmit(); true"
    )
    time.sleep(1.5)
    results.append(f"slack saved: {value(fields)}")
    rules = in_worker(devtools, extension_id, "chrome.declarativeNetRequest.getDynamicRules().then((rules) => rules.map((rule) => rule.id).sort().join(','))")
    results.append(f"redirect rules: {rules}")

    # One state per site: disable it (the list says so, and Enable is offered), then enable it again.
    state = """(id) => {
      const row = document.querySelector(`.site-row[data-site="${id}"]`);
      const off = [...row.querySelectorAll('.note')].some((note) => note.textContent === 'disabled' && !note.hidden);
      return `${off ? 'disabled' : 'enabled'}, offers ${row.querySelector('button').textContent}`;
    }"""
    switched_off = "chrome.storage.local.get('settings').then(({ settings }) => settings.disabledSites.join(',') || 'none')"
    for action in ("Disable", "Enable"):
        value(f"({buttons})('dashboard').find((button) => button.textContent === '{action}').click(); true")
        time.sleep(1.5)
        shown = value(f"({state})('dashboard')")
        count = value("document.getElementById('sites-count').textContent")
        results.append(f"after {action}: {shown}; switched off: {value(switched_off)}; heading says {count}")

    # Disabling is the exception: a copy of a disabled site starts enabled.
    value(f"({buttons})('acme').find((button) => button.textContent === 'Disable').click(); true")
    time.sleep(1.5)

    # Duplicate the recorded site for its staging copy: only the address changes, and the name follows it.
    value(
        f"""({buttons})('acme').find((button) => button.textContent === 'Duplicate').click();
        const address = document.querySelector('[data-field="host0"]');
        address.value = 'https://acme.staging.example.test/';
        address.dispatchEvent(new Event('input', {{ bubbles: true }}));
        document.getElementById('editor-save').click()"""
    )
    time.sleep(1.5)
    copy = json.loads(value(stored.replace("site.id === 'acme'", "site.id === 'acme-staging'")))
    results.append(f"duplicate: {copy['label']}, {copy['host']}, {copy['home']}, then {copy['steps'][1]['host']}, {len(copy['steps'])} steps")
    copy_state = value(f"({state})('acme-staging')")
    results.append(f"the copy of a disabled site: {copy_state}; switched off: {value(switched_off)}")

    value(
        f"""({edit.replace("if (!editor.hidden) document.getElementById('editor-cancel').click();", "")})('acme');
        document.querySelector('[data-field="label"]').value = 'Acme (edited)';
        document.querySelector('[data-field="labels"]').value = 'staging';
        document.getElementById('editor-save').click()"""
    )
    time.sleep(1.5)
    edited = json.loads(value(stored))
    results += [f"edited: {edited['label']} {edited.get('labels')} with {len(edited['steps'])} steps"]
    value(
        f"""({buttons})('acme').find((button) => button.textContent === 'Remove').click();
        document.querySelector('.site-row[data-site="acme"]').querySelector('button.danger').click()"""
    )
    time.sleep(1.5)
    results += [f"after removing: {value(stored)}", f"sites listed: {value(rows)}", f"switched off: {value(switched_off)}"]

    # The popup's "Record a site" leaves a request for this page: the form opens with the tab's address.
    in_worker(devtools, extension_id, "chrome.storage.session.set({ recordRequest: { url: 'https://acme.example.test/', at: Date.now() } })")
    time.sleep(1)
    form = value("`${document.getElementById('record-form').hidden ? 'closed' : 'open'}, ${document.getElementById('record-url').value}`")
    results.append(f"record form from the popup: {form}")
    return results


def banner_on(devtools, url_prefix, press_key=False):
    """The extension's banner on the open page whose address starts with url_prefix; with
    press_key, after a real (trusted) keystroke there."""
    target = next(t for t in devtools.call("Target.getTargets")["targetInfos"] if t["type"] == "page" and t["url"].startswith(url_prefix))
    session = devtools.call("Target.attachToTarget", targetId=target["targetId"], flatten=True)["sessionId"]
    if press_key:
        devtools.call("Input.dispatchKeyEvent", session_id=session, type="keyDown", key="1", text="1")
        devtools.call("Input.dispatchKeyEvent", session_id=session, type="keyUp", key="1")
        time.sleep(0.3)
    reply = devtools.call(
        "Runtime.evaluate", session_id=session, expression="document.getElementById('sas-banner')?.textContent ?? null", returnByValue=True
    )
    return reply["result"].get("value")


def check_recorder(devtools, extension_id):
    """Records Acme from the options page, the way a person would: in the recording tab, real
    (trusted) clicks and typing, sent through the DevTools Input domain, on Acme's pages and on
    Google's, which are signed in by hand. Then Done in the recorder's bar, and Save in the review
    the options page opens. Returns the steps it listed and the site it saved."""

    def attach(target_id):
        return devtools.call("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"]

    def value(session, expression, gesture=False):
        reply = devtools.call(
            "Runtime.evaluate", session_id=session, expression=expression, returnByValue=True, awaitPromise=True, userGesture=gesture
        )
        if "exceptionDetails" in reply:
            raise RuntimeError(f"{expression}: {reply['exceptionDetails'].get('text')}")
        return reply["result"].get("value")

    def wait_for(session, expression, what, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if value(session, expression):
                    return
            except RuntimeError:
                pass  # mid-navigation
            time.sleep(0.2)
        raise RuntimeError(f"recorder: {what} never happened")

    def click(session, element):
        x, y = value(
            session,
            f"(() => {{ const el = {element}; el.scrollIntoView({{ block: 'center' }}); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }})()",
        )
        for kind in ("mousePressed", "mouseReleased"):
            devtools.call("Input.dispatchMouseEvent", session_id=session, type=kind, x=x, y=y, button="left", clickCount=1)

    by_id = lambda id: f"document.getElementById('{id}')"
    # The hand-written Acme goes; the recording replaces it.
    in_worker(
        devtools,
        extension_id,
        "chrome.storage.local.get('config').then(({ config }) => chrome.storage.local.set({ config: { ...config, sites: config.sites.filter((site) => site.id !== 'acme') } }))",
    )
    time.sleep(1)
    options = attach(devtools.call("Target.createTarget", url=f"chrome-extension://{extension_id}/src/options/options.html", newWindow=True)["targetId"])
    time.sleep(1.5)
    before = {t["targetId"] for t in devtools.call("Target.getTargets")["targetInfos"]}
    value(
        options,
        # No name: it comes from the address (acme.example.test is "Acme").
        f"{by_id('record-site')}.click(); {by_id('record-url')}.value = '{ACME}'; {by_id('record-start')}.click(); true",
        gesture=True,
    )
    deadline = time.monotonic() + 10
    tab = None
    while not tab and time.monotonic() < deadline:
        time.sleep(0.2)
        tab = next(
            (t for t in devtools.call("Target.getTargets")["targetInfos"] if t["targetId"] not in before and t["type"] == "page" and t["url"].startswith(f"https://{ACME}/")),
            None,
        )
    if not tab:
        raise RuntimeError("recorder: the recording tab never opened")
    page = attach(tab["targetId"])
    recorder = "Boolean(document.getElementById('sas-recorder'))"

    wait_for(page, recorder, "the recorder's bar on Acme")
    click(page, by_id("log-in"))
    wait_for(page, f"location.hostname === '{ACME_LOGIN}' && {recorder}", "the recorder's bar on the sign-in host")
    # The recorder fills in the email from the options itself: nothing to type.
    wait_for(page, f"{by_id('email')}.value === '{EMAIL}'", "the recorder filling in the email")
    click(page, by_id("continue"))
    wait_for(page, f"!{by_id('providers')}.hidden", "the Google button")
    click(page, by_id("google"))
    wait_for(page, f"location.hostname === 'accounts.google.com' && Boolean({by_id('account')})", "Google's account chooser")
    # The recorder's bar isn't on Google's pages; a banner says why.
    wait_for(page, "(document.getElementById('sas-banner')?.textContent ?? '').startsWith('Recording Acme')", "the recording banner on Google")
    banner = value(page, "document.getElementById('sas-banner').textContent")
    click(page, by_id("account"))
    wait_for(page, f"location.pathname === '/signin/oauth/id' && Boolean({by_id('continue')})", "Google's Continue page")
    click(page, by_id("continue"))
    wait_for(page, f"location.pathname === '/projects' && {recorder}", "Acme's projects page")
    click(page, f"{by_id('sas-recorder')}.shadowRoot.querySelector('[data-action=\"done\"]')")

    wait_for(options, f"!{by_id('site-editor')}.hidden && !{by_id('editor-steps')}.hidden", "the review in the options page")
    steps = value(options, "[...document.querySelectorAll('#editor-step-list li > span:first-child')].map((s) => s.textContent)")
    value(options, f"{by_id('editor-save')}.click(); true", gesture=True)
    time.sleep(1.5)
    saved = value(options, "chrome.storage.local.get('config').then(({ config }) => JSON.stringify(config.sites.find((site) => site.id === 'acme') ?? null))")
    devtools.call("Target.closeTarget", targetId=tab["targetId"])
    return [f"google banner: {banner.split('.')[0]}"] + [f"step: {step}" for step in steps] + [f"saved: {json.dumps(json.loads(saved), sort_keys=True, separators=(',', ':'))}"]


def stop_browser(process, devtools):
    try:
        devtools.call("Browser.close")
    except (EOFError, OSError, RuntimeError):
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def run(args, work):
    current = {"events": [], "done": lambda e: False, "finished": threading.Event()}
    log_path = os.path.join(work, "browser.log")
    failures, status = [], 0
    with open(log_path, "w") as log:
        # Launch before starting the server thread: subprocess and threads don't mix well.
        process, devtools = launch_browser(args.browser, args.port, os.path.join(work, "profile"), log)
        server = None
        try:
            server = start_server(args.port, work, current)
            extension_id = devtools.call("Extensions.loadUnpacked", path=test_copy(work))["id"]
            save_settings(devtools, extension_id, {"email": EMAIL, "landingUrl": "https://app.slack.com/client/T0123ABCD/C0123ABCD"})
            # The sites come from a config file, imported as the options page would.
            with open(os.path.join(REPO, "test", "sites.json")) as f:
                config = json.load(f)
            config["sites"].append(ACME_SITE)
            configured = len(config["sites"])
            in_worker(devtools, extension_id, f"chrome.storage.local.set({{ config: {json.dumps(config)} }})")
            time.sleep(1)  # let the extension register its site content scripts for the new config
            print(f"Loaded extension {extension_id}", flush=True)

            def run_scenario(scenario):
                nonlocal status
                print(f"\n{scenario['name']}", flush=True)
                current.update(events=[], done=scenario["done"], finished=threading.Event())
                if "setup" in scenario:
                    in_worker(devtools, extension_id, scenario["setup"])
                for start in scenario["start"] if isinstance(scenario["start"], list) else [scenario["start"]]:
                    devtools.call("Target.createTarget", url=start, newWindow=True)
                if not current["finished"].wait(args.timeout):
                    failures.append(f"{scenario['name']}: timed out after {args.timeout:.0f}s")
                    status = max(status, 2)
                    return
                expression, wait = scenario["check"]
                time.sleep(wait)  # e.g. for the page to settle, which is what ends some runs
                result = in_worker(devtools, extension_id, expression)
                current["events"].append(result)
                print(f"  {result}", flush=True)
                if "teardown" in scenario:
                    in_worker(devtools, extension_id, scenario["teardown"])
                events, expected = current["events"], scenario["expected"]
                if scenario.get("unordered"):
                    events, expected = sorted(events), sorted(expected)
                if events != expected:
                    failures.append(f"{scenario['name']}: expected {scenario['expected']}")
                    status = max(status, 1)

            for scenario in SCENARIOS:
                run_scenario(scenario)

            # The banner stays on the page where a sign-in handed over, so it's clear what's next.
            print("\nThe banner where the Error tracker's sign-in handed over", flush=True)
            banner = banner_on(devtools, "https://errors.example.test/auth/2fa")
            print(f"  {banner}", flush=True)
            if banner != "Auto sign-in: over to you on Error tracker's 2FA page.":
                failures.append(f"Handover banner: got {banner!r}")
                status = max(status, 1)
            # It's over to me: the banner goes as soon as I start typing the code.
            after_typing = banner_on(devtools, "https://errors.example.test/auth/2fa", press_key=True)
            print(f"  after a keystroke: {after_typing}", flush=True)
            if after_typing is not None:
                failures.append(f"Handover banner after a keystroke: got {after_typing!r}")
                status = max(status, 1)

            print("\nRecording Acme from the options page, signing in by hand", flush=True)
            current.update(events=[], done=lambda e: False, finished=threading.Event())
            results = check_recorder(devtools, extension_id)
            for line in results:
                print(f"  {line}", flush=True)
            recorded = {
                "type": "button",
                "id": "acme",
                "label": "Acme",
                "host": ACME,
                "home": f"https://{ACME}/projects",
                "steps": [
                    {"path": "/", "click": {"selectors": ["#log-in"], "texts": ["Log in"]}},
                    {"host": ACME_LOGIN, "path": "/login", "email": {"selectors": ["#email"]}, "click": {"selectors": ["#continue"], "texts": ["Continue"]}},
                    {"host": ACME_LOGIN, "path": "/login", "click": {"selectors": ["#google"], "texts": ["Continue with Google"]}},
                ],
            }
            expected = [
                "google banner: Recording Acme: this is Google's single sign-on for Acme",
                'step: On /: click "Log in"',
                f'step: On {ACME_LOGIN}/login: fill in your email, then click "Continue"',
                f'step: On {ACME_LOGIN}/login: click "Continue with Google"',
                f"saved: {json.dumps(recorded, sort_keys=True, separators=(',', ':'))}",
            ]
            if results != expected:
                failures.append(f"Recorder: expected {expected}")
                status = max(status, 1)
            run_scenario({**ACME_SCENARIO, "name": "Acme again, as recorded"})
            print("\nThe popup, then Sign out of all from it", flush=True)
            results = check_popup(devtools, extension_id)
            for line in results:
                print(f"  {line}", flush=True)
            expected = ["status shown: True", f"sites listed: {configured}", "cookie before: True", "cookie after: False", "auto sign-in on: false"]
            if results != expected:
                failures.append(f"Popup: expected {expected}")
                status = max(status, 1)
            print("\nThe options page: each site's view, Slack's settings, editing and removing a site", flush=True)
            results = check_options_editor(devtools, extension_id)
            for line in results:
                print(f"  {line}", flush=True)
            expected = [
                f"sites listed: {configured}",
                "google's buttons: Disable",
                "acme opens in: steps",
                "internal opens in: JSON",
                "slack opens in: focus:slackWorkspace",
                "slack section: example T0123ABCD true true",
                "slack saved: example T0123ABCD false true",
                "redirect rules: 2,3",
                f"after Disable: disabled, offers Enable; switched off: dashboard; heading says {configured} sites, 1 disabled",
                f"after Enable: enabled, offers Disable; switched off: none; heading says {configured} sites",
                "duplicate: Acme (staging), acme.staging.example.test, https://acme.staging.example.test/projects, then login.acme.example.test, 3 steps",
                "the copy of a disabled site: enabled, offers Disable; switched off: acme",
                "edited: Acme (edited) ['staging'] with 3 steps",
                "after removing: null",
                f"sites listed: {configured}",
                "switched off: none",
                "record form from the popup: open, https://acme.example.test/",
            ]
            if results != expected:
                failures.append(f"Options page: expected {expected}")
                status = max(status, 1)
        except (RuntimeError, EOFError, OSError, subprocess.CalledProcessError) as error:
            failures.append(f"E2E ERROR: {error}")
            status = 3
        finally:
            if server:
                server.shutdown()
            stop_browser(process, devtools)

    if not failures:
        print("\nE2E PASSED")
        return 0
    print("\nE2E FAILED", *failures, sep="\n", file=sys.stderr)
    with open(log_path) as f:
        noise = ("crashpad", "cv_display_link", "DevTools listening")
        lines = [line.rstrip() for line in f if line.strip() and not any(n in line for n in noise)]
    if lines:
        print("--- browser log", *lines[-20:], sep="\n", file=sys.stderr)
    return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", default=os.environ.get("BROWSER", DEFAULT_BROWSER))
    parser.add_argument("--port", type=int, default=int(os.environ.get("E2E_PORT", 8766)))
    parser.add_argument("--timeout", type=float, default=60, help="per scenario")
    args = parser.parse_args()

    work = tempfile.mkdtemp(prefix="auto-sign-in-e2e-")
    try:
        return run(args, work)
    finally:
        # Browser helper processes can outlive the main one by a moment.
        for _ in range(5):
            shutil.rmtree(work, ignore_errors=True)
            if not os.path.exists(work):
                break
            time.sleep(0.5)


if __name__ == "__main__":
    sys.exit(main())
