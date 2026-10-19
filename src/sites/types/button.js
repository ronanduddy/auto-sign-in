// The "button" site type: the site's own sign-in steps (usually one "Sign in with Google" button),
// then Google, then optionally the site's own verification pages (an MFA code, say), where the
// extension hands over. It covers "Sign in with Google" buttons, SAML sign-in forms and sign-ins
// that take a few steps (a "Log in" link, an email box, a second host). Built from the normalised
// config that src/config/schema.js produces:
//
// {
//   id, label, labels, home, matches, reloadOnInstall,
//   steps: [{ name, path, host?, button: { selectors?, texts? }, email?: { selectors },
//             reloadIfOlderThanMs?, label, pageLabel }],
//   signInHosts: [host],          // hosts only used for signing in: never signed in there
//   google: { mentions: [text], appNames: [text] },
//   handover: [{ path, selectors, label, pageLabel, waitingFor }],
//   notSignedIn: [path rule],   // "/x*" matches paths starting /x; anything else matches exactly
// }
//
// Steps are rules, not a script: on a page where a step's element shows, that's the step. A run
// does each step at most once (the engine passes the ones done as `done`), so where a page shows
// several, the first one the run hasn't done yet wins.

import { STEP } from '../../lib/steps.js';

export function pathMatches(rule, path) {
  if (rule.endsWith('*')) return path.startsWith(rule.slice(0, -1));
  return path === rule || path === `${rule}/`;
}

// A step's email box, as an element name.
const emailElement = (step) => `${step.name}Email`;

export function buttonSite(site) {
  const elements = {};
  for (const step of site.steps) {
    const where = { path: step.path, ...(step.host && { hosts: [step.host] }) };
    elements[step.name] = { label: step.label, ...where, ...step.button };
    if (step.email) elements[emailElement(step)] = { label: `${site.label}'s email box`, ...where, selectors: step.email.selectors };
  }
  site.handover.forEach((page, i) => {
    elements[`handover${i + 1}`] = { label: page.label, path: page.path, selectors: page.selectors };
  });

  return {
    id: site.id,
    label: site.label,
    labels: site.labels,
    home: site.home,
    matches: site.matches,
    reloadOnInstall: site.reloadOnInstall,
    google: site.google,
    elements,

    classify({ url, found, settled, done = [] }) {
      // A verification page wins: it means Google is done and the site wants a code from me.
      const index = site.handover.findIndex((_, i) => found[`handover${i + 1}`]);
      if (index >= 0) {
        const page = site.handover[index];
        return { step: STEP.HANDOVER, focus: `handover${index + 1}`, label: page.pageLabel, badge: 'MFA', waitingFor: page.waitingFor };
      }
      // An email step shows once its box does (its button may only enable after typing).
      const showing = site.steps.filter((step) => found[step.email ? emailElement(step) : step.name]);
      if (showing.length) {
        // A step already done in this run means the sign-in came back round: a new attempt.
        const step = showing.find((s) => !done.includes(s.name)) ?? showing[0];
        return {
          step: STEP.LOGIN,
          siteStep: step.name,
          click: step.name,
          ...(step.email && { fillEmail: emailElement(step) }),
          label: step.pageLabel,
          reloadIfOlderThan: step.reloadIfOlderThanMs,
        };
      }
      // Signed in once one of its other pages has stayed put without a sign-in button.
      if (settled && !site.signInHosts.includes(url.hostname) && !site.notSignedIn.some((rule) => pathMatches(rule, url.pathname))) {
        return { step: STEP.SIGNED_IN, label: site.label };
      }
      return null;
    },
  };
}
