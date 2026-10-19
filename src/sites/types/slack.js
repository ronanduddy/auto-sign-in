// The "slack" site type: one Slack workspace. Slack signs you out and sends the tab to its
// workspace picker; from there it's the workspace's sign-in page (Google button), Google, then
// Slack's own MFA, where the extension hands over. After MFA, Slack's desktop-app launcher
// (/ssb/redirect) is redirected straight to a channel, skipping the "Open Slack?" prompt.
//
// Config: { id, label, workspace, teamId, labels? }, e.g. workspace "acme" for acme.slack.com.

import { STEP } from '../../lib/steps.js';

// The sign-in page's CSRF token goes stale, so pages older than this are reloaded before clicking.
export const STALE_MS = 2 * 60_000;
const DESKTOP_PROMPT_RULE_ID = 1;
const LANDING_RULE_ID = 3; // Google's is 2

// True unless the workspace picker is asking about other workspaces. When Slack signs you out, it
// adds a redir naming the team; signing out by hand lands on the bare page.
export function pickerIsForTeam(url, teamId) {
  try {
    const redir = new URL(url).searchParams.get('redir');
    if (!redir) return true;
    const teams = new URLSearchParams(redir.slice(redir.indexOf('?') + 1)).get('teams');
    return !teams || teams.split(',').includes(teamId);
  } catch {
    return false;
  }
}

export function isLandingUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'app.slack.com' && u.pathname.startsWith('/client/');
  } catch {
    return false;
  }
}

export function slackSite({ id, label, workspace, teamId, labels = [] }) {
  const teamHost = `${workspace}.slack.com`;
  const teamUrl = `https://${teamHost}/`;
  return {
    id,
    label,
    labels,
    // Signed in, this goes to the client; signed out, to the sign-in page.
    home: teamUrl,
    workspace: { host: teamHost, url: teamUrl, teamId },
    matches: ['https://app.slack.com/workspace-signin*', `https://app.slack.com/client/${teamId}*`, `https://${teamHost}/*`],
    // Its signed-in status shows on the badge (✓/✗).
    tracksSignIn: true,
    // Open tabs matching these show I'm signed in, which restores the badge after a reload.
    signedInTabs: [`https://app.slack.com/client/${teamId}*`],
    // Open tabs matching these are safe to reload, so they pick up a newly installed content script.
    reloadOnInstall: ['https://app.slack.com/workspace-signin*'],
    google: { mentions: ['slack.com'], appNames: ['slack'] },

    elements: {
      googleButton: {
        label: "Slack's Google button",
        hosts: [teamHost],
        selectors: ['[data-qa="base_google_login_button"]', '#google_login_button'],
      },
      mfaInput: {
        label: "Slack's MFA code box",
        hosts: [teamHost],
        // Digit 1 first, so focusing this lands in the right box.
        selectors: [
          'input[aria-label="digit 1 of 6"]',
          'input[autocomplete="one-time-password"]',
          '.two_factor_input_item input',
        ],
      },
    },

    classify({ url, found, settled }) {
      if (url.hostname === 'app.slack.com') {
        if (url.pathname.startsWith('/workspace-signin')) {
          return pickerIsForTeam(url.href, teamId) ? { step: STEP.REDIRECT, url: teamUrl, label: 'the workspace picker' } : null;
        }
        // A signed-out client page redirects to the picker at once, so one that stays put is signed in.
        if (url.pathname.startsWith(`/client/${teamId}`) && settled) return { step: STEP.SIGNED_IN, label };
        return null;
      }
      if (url.hostname === teamHost) {
        // Sign-in options and MFA share the same URL, so only the page content tells them apart.
        if (found.mfaInput) {
          return { step: STEP.HANDOVER, focus: 'mfaInput', label: "Slack's MFA page", badge: 'MFA', waitingFor: 'your MFA code' };
        }
        if (found.googleButton) {
          return { step: STEP.LOGIN, click: 'googleButton', label: "Slack's sign-in page", reloadIfOlderThan: STALE_MS };
        }
      }
      return null;
    },

    // Two separate settings, each a redirect rule:
    //  - skipDesktopPrompt: after MFA, Slack sends the tab to /ssb/redirect, which asks the browser
    //    to open the desktop app ("Open Slack?"). Redirecting that page skips the prompt, to Slack
    //    in the browser: the landing page if there is one, otherwise the workspace's default view.
    //  - goToSlackLanding with a landingUrl: whenever Slack in the browser opens on the workspace's
    //    default view (as it does after signing in), go to the landing page instead. A link to a
    //    channel or message isn't the default view, so it's left alone.
    rules(settings) {
      const defaultView = `https://app.slack.com/client/${teamId}`;
      const defaultViewPattern = `^https://app\\.slack\\.com/client/${teamId}/?(\\?.*)?$`; // RE2, for the rule
      const landing =
        settings.goToSlackLanding && isLandingUrl(settings.landingUrl) && !new RegExp(defaultViewPattern).test(settings.landingUrl)
          ? settings.landingUrl
          : null;
      const rules = [];
      if (settings.skipDesktopPrompt) {
        rules.push({
          id: DESKTOP_PROMPT_RULE_ID,
          priority: 1,
          action: { type: 'redirect', redirect: { url: landing ?? defaultView } },
          condition: { urlFilter: `|https://${teamHost}/ssb/redirect`, resourceTypes: ['main_frame'] },
        });
      }
      if (landing) {
        rules.push({
          id: LANDING_RULE_ID,
          priority: 1,
          action: { type: 'redirect', redirect: { url: landing } },
          condition: { regexFilter: defaultViewPattern, resourceTypes: ['main_frame'] },
        });
      }
      return rules;
    },
  };
}
