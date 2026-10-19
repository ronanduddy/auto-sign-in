#!/bin/sh
# End-to-end test: loads this repo as an extension into headless Brave, points the Slack
# and Google hostnames at the mock pages in test/e2e/pages, starts from Slack's sign-out
# URL and checks the extension walks the whole flow to the landing channel.
# See test/e2e/run.py. BROWSER=/path/to/chromium and E2E_PORT=n override the defaults.
set -eu
cd "$(dirname "$0")/.."
exec python3 test/e2e/run.py "$@"
