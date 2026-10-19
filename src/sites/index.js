// Sites ("loops") come from the config (src/config/schema.js, with an example in
// config/example.json), not from code. The code provides:
//
//   types/       the kinds of site: button (the site's sign-in steps, usually recorded, then
//                Google, optionally the site's own verification pages), slack (a workspace) and
//                google (Google itself)
//   presets.js   the two built-in sites a config names by preset: google and slack
//   build.js     config -> site definitions -> registry
//   registry.js  the lookups the engine, background, popup and options use
//
// A site definition, as the engine sees it:
//   id, label, labels   identity, and labels such as "requires VPN" shown beside it
//   home                the page the popup and options link to (opening it signed out starts the loop)
//   matches             URL patterns (manifest syntax) of the site's pages
//   google              { mentions, appNames }: text that appears in Google's URL during the site's
//                       sign-in (usually its host), and its app name in Google's "to continue to …"
//                       line. Either one is enough.
//   elements            { name: { label, selectors?, texts?, hosts?, path? } }: what the content
//                       script looks for. Plain data, because it's sent to the content script.
//   classify({ url, found, settled, done })
//                       what a page is: null, or { step, label, ... } with step one of STEP.REDIRECT
//                       (+ url), STEP.LOGIN (+ click, reloadIfOlderThan?), STEP.HANDOVER (+ focus,
//                       badge?, waitingFor?) or STEP.SIGNED_IN
//   optional:           tracksSignIn (✓/✗ badge), signedInTabs and reloadOnInstall (URL patterns
//                       used when the extension is installed or reloaded), rules(settings)
//                       (declarativeNetRequest rules), googleItself (the Google loop)
//
// Every site's flow goes through Google's sign-in steps as part of its own run, so a site doesn't
// need to depend on the Google loop explicitly.

export { createRegistry, matchesPattern } from './registry.js';
export { buildSites, buildRegistry } from './build.js';
export { PRESETS } from './presets.js';
