#!/bin/sh
# Runs the test suite (test/run.html) in headless Brave, the Chromium browser this Chrome
# extension is developed in. No Node needed:
# scripts/test-server.py serves the repo (ES modules won't load from file://)
# and prints the report the page POSTs back when it finishes.
#
# To watch the tests in a normal browser instead:
#   python3 -m http.server 8765   then open http://127.0.0.1:8765/test/run.html
#
# BROWSER=/path/to/chromium and PORT=n override the defaults.
set -eu

cd "$(dirname "$0")/.."
BROWSER="${BROWSER:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}"
PORT="${PORT:-8765}"

# One attempt: serve the repo, run the page in a fresh headless profile, print the report.
# Exits 0 passed, 1 failed, 2 no report (the browser didn't get as far as running the page).
attempt() {
  profile="$(mktemp -d)"
  browser=""
  python3 scripts/test-server.py --port "$PORT" &
  server=$!

  for _ in $(seq 1 25); do
    curl -fs -o /dev/null "http://127.0.0.1:$PORT/test/run.html" && break
    sleep 0.2
  done

  # --use-mock-keychain stops a fresh profile from hanging on a macOS keychain prompt; the
  # --disable-* flags stop the browser downloading components it doesn't need for the tests.
  "$BROWSER" --headless=new --use-mock-keychain --disable-gpu --no-first-run --no-default-browser-check \
    --disable-background-networking --disable-component-update \
    --user-data-dir="$profile" "http://127.0.0.1:$PORT/test/run.html" >/dev/null 2>&1 &
  browser=$!

  result=0
  wait "$server" || result=$?
  cleanup
  return "$result"
}

cleanup() {
  if [ -n "$browser" ]; then
    kill "$browser" 2>/dev/null || true
    wait "$browser" 2>/dev/null || true
  fi
  kill "$server" 2>/dev/null || true
  rm -rf "$profile" 2>/dev/null || true
}
server=""
browser=""
profile=""
trap cleanup EXIT INT TERM

# A headless browser occasionally never gets as far as the page; give it a second go.
status=0
attempt || status=$?
if [ "$status" -eq 2 ]; then
  echo "No report from the browser; trying once more." >&2
  status=0
  attempt || status=$?
fi
exit "$status"
