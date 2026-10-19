// The steps a sign-in run moves through. Site definitions (src/sites/) map their pages to
// the first four; the Google steps are shared by every site that signs in with Google.
export const STEP = Object.freeze({
  // Site pages, returned by a site's classify():
  REDIRECT: 'redirect', // go straight to the site's real sign-in page (Slack's workspace picker)
  LOGIN: 'login', // click the site's "Sign in with Google" button
  HANDOVER: 'handover', // focus a box for me to type into, and end the run (Slack's MFA)
  SIGNED_IN: 'signedIn', // the site's normal pages: signed in, so the run is done

  // Google's sign-in pages:
  GOOGLE_CHOOSER: 'google_chooser',
  GOOGLE_VERIFY: 'google_verify',
  GOOGLE_IDENTIFIER: 'google_identifier',
  GOOGLE_PASSWORD: 'google_password',
  GOOGLE_CHALLENGE: 'google_challenge',
  GOOGLE_CONSENT: 'google_consent',
});
