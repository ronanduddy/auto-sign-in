// The "google" site type: Google itself. Every other site's flow already goes through Google's
// sign-in pages (account chooser, password, 2-Step, Continue/Allow), and the engine handles those
// inline as part of that site's run. This covers landing on Google's sign-in directly: Google's
// own account chooser, or Gmail and Drive asking you to sign in again. It's often the first thing
// to do in the morning, because every other site depends on the Google session.
//
// It only starts on a sign-in to Google itself (no OAuth client, SAML request or third-party
// redirect in the URL), and never clicks Continue/Allow: those belong to another app's sign-in.
// Its pages are handled by the engine's shared Google steps, so classify() has nothing to add.
//
// Config: { id?, label?, labels? }.

const LANDING_RULE_ID = 2; // Slack's is 1

export function googleSite({ id = 'google', label = 'Google', labels = [] } = {}) {
  return {
    id,
    label,
    labels,
    // Needs a Google sign-in, so opening it signed out starts this loop.
    home: 'https://myaccount.google.com/',
    matches: ['https://accounts.google.com/v3/signin/*'],
    // Google pages aren't checked against another site, but the format wants these.
    google: { mentions: ['accounts.google.com'], appNames: ['gmail', 'google', 'youtube'] },
    elements: {},
    // Starts its own runs from Google's sign-in pages (see engine.js, decideGoogle).
    googleItself: true,
    classify() {
      return null;
    },

    // Signed in with nowhere else to go, Google lands on its account page with these markers in
    // the address. Redirecting that straight to the landing page (Gmail) is instant, like Slack's
    // landing channel. A visit to My Account by hand doesn't carry the markers, so it's untouched.
    rules(settings) {
      if (!settings.goToGoogleLanding || !/^https:\/\//.test(settings.googleLandingUrl ?? '')) return [];
      return [
        {
          id: LANDING_RULE_ID,
          priority: 1,
          action: { type: 'redirect', redirect: { url: settings.googleLandingUrl } },
          condition: {
            regexFilter: '^https://myaccount\\.google\\.com/\\?(.*&)?(utm_source=sign_in_no_continue|pli=1)(&|$)',
            resourceTypes: ['main_frame'],
          },
        },
      ];
    },
  };
}
