# Contributing

Thanks for taking a look. Auto sign-in is plain JavaScript with no build step and no dependencies, so getting started is quick.

## Running it

1. Open your browser's extensions page (`chrome://extensions`, or the same in Brave or Edge) and switch on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. After changing anything, click the reload icon on the extension's card.

## Tests

Both suites run in a headless Chromium browser, with the system `python3` (3.9 or later). Node isn't needed.

```sh
scripts/test.sh   # unit and DOM tests (test/run.html)
scripts/e2e.sh    # the whole extension against mock pages on example hosts
```

They default to Brave on macOS. Set `BROWSER=/path/to/browser` to use another Chromium-based browser. To watch the unit tests in a normal browser, run `python3 -m http.server 8765` and open `http://127.0.0.1:8765/test/run.html`.

Please run both before opening a pull request, and add tests with changes: the engine (`src/lib/engine.js`) and the recorder's logic (`src/lib/recording.js`, `src/content/locate.js`) are written to be unit tested.

## Ground rules

- **No secrets.** Nothing may read, store or fill in a password, a verification code, a cookie or a token. See [SECURITY.md](SECURITY.md).
- **No products in the code.** Sites are the user's own data, recorded or written in a config file. Only Google itself and Slack are built in, because what they do can't be recorded. Tests use made-up sites on example hosts (`test/sites.json`).
- **Keep the docs in step.** README, `docs/plan-configurable.md` and `docs/selectors.md` describe how it behaves; update them with the change.
- **Match the code around you:** plain ES modules, small functions, comments that say why.

## Reporting a security problem

Privately, through the repository's **Security** tab, please: see [SECURITY.md](SECURITY.md).
