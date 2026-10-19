// Timings for sign-in runs, and the settings I can change from the options page.
// Everything about a particular site lives in its definition in src/sites/.

export const RUN_WINDOW_MS = 2 * 60_000; // a run stays alive this long after its latest step
export const WAIT_WINDOW_MS = 10 * 60_000; // ...or this long while it waits for me to type a password
export const GUARD_MAX_RUNS = 3; // automatic runs allowed per site per GUARD_WINDOW_MS
export const GUARD_WINDOW_MS = 15 * 60_000;
export const BADGE_CLEAR_MS = 5 * 60_000;
export const OTHER_TAB_RETRY_MS = 5000; // a sign-in page waiting for another tab's run asks again this often
export const GOOGLE_LEAVE_GRACE_MS = 8000; // the Google loop is done if no Google page follows within this after leaving one
export const LOG_SIZE = 10;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  dryRun: false,
  email: '',
  // Slack, two separate things: skip the "Open Slack?" desktop-app prompt after signing in (going
  // to Slack in the browser instead), and open landingUrl (a channel, say) instead of the
  // workspace's default view.
  skipDesktopPrompt: true,
  goToSlackLanding: true, // only applies with a landingUrl
  landingUrl: '',
  submitAutofilledPassword: true, // click Next once a password manager fills Google's password box
  // Google's 2-Step page: tick "Don't ask again on this device", and click Next once the 6-digit code is in.
  googleTwoStepAssist: true,
  disabledSites: [], // ids of sites (src/sites/) not to sign in to automatically
  // Google: after the Google loop signs in, go here instead of Google's own account page.
  goToGoogleLanding: true,
  googleLandingUrl: 'https://mail.google.com/mail/',
});
