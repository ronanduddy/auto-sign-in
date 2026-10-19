// Turns a parsed config (src/config/schema.js) into the site definitions the engine runs, and
// those into a registry.

import { buttonSite } from './types/button.js';
import { googleSite } from './types/google.js';
import { slackSite } from './types/slack.js';
import { createRegistry } from './registry.js';

const TYPES = { button: buttonSite, google: googleSite, slack: slackSite };

export function buildSites(config) {
  return config.sites.map((site) => TYPES[site.type](site));
}

export function buildRegistry(config) {
  return createRegistry(buildSites(config));
}
