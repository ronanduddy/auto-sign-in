// Selectors and page text for Google's sign-in pages, which every site's flow shares. Each
// site's own elements live in its definition in src/sites/ and reach the content script from
// the background worker. docs/selectors.md records where these came from. Selector lists are
// tried in order; the first visible match wins. texts match a clickable's whole text, ignoring case.
globalThis.SAS_SELECTORS = {
  // Where elements found by their text are looked for.
  clickables: 'a, button, [role="button"], [role="link"]',
  google: {
    // Something interactive has rendered, so the page is worth looking at.
    rendered: 'button, [role="button"], [role="link"], input:not([type="hidden"])',
    // The account row is whichever of these is the nearest ancestor of the email text.
    accountRowClickable: '[data-identifier], [data-email], [role="link"], [role="button"], button, a, li',
    // The 2-Step page's "Don't ask again on this device" checkbox, found by its label text.
    rememberDeviceLabel: 'ask again on this device',
    // 2-Step pages where the code isn't 6 digits (backup codes are 8), so Next is left to me.
    longCodePaths: ['/v3/signin/challenge/bc'],
    // "Choose an account / to continue to Slack": captures the app name.
    continueTo: /to continue to\s+(.+)/i,
    verifyHeading: /verify (that )?it[’']s you/i,
    // The app named on Google's Continue/Allow pages: "Sign in to Slack", "Acme wants access to
    // your Google Account". Captures the name.
    consentApp: [/sign in to\s+(.+)/i, /^(.+?) wants (?:additional )?access to your google account/im],
    elements: {
      // Google keeps hidden password and email inputs around for autofill; skip those.
      googlePassword: {
        label: "Google's password box",
        selectors: ['input[type="password"]:not([aria-hidden="true"]):not([tabindex="-1"])'],
      },
      // Seen 2026-10-16: <input type="text" name="identifier" autocomplete="username" id="identifierId">.
      googleEmail: {
        label: "Google's email box",
        selectors: [
          'input#identifierId',
          'input[name="identifier"]:not([type="hidden"])',
          'input[type="email"]:not([aria-hidden="true"]):not([tabindex="-1"])',
        ],
      },
      googleCode: {
        label: "Google's code box",
        selectors: [
          'input#totpPin',
          'input[name="totpPin"]',
          'input[autocomplete="one-time-code"]',
          'input[type="tel"]',
          'input[type="number"]',
          'input[type="text"]:not([aria-hidden="true"])',
        ],
      },
      googleNext: { label: "Google's Next button", texts: ['Next'] },
      googleConsent: { label: "Google's Continue/Allow button", texts: ['Continue', 'Allow'] },
    },
  },
};
