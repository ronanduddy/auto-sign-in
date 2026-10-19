// The two built-in sites a config names by preset: Google itself (its own sign-in, for Gmail and
// Google's pages) and a Slack workspace ("preset": "slack", plus its workspace and team ID).
// Neither can be recorded: what they do lives in their types (src/sites/types/). Every other site
// is recorded in the options page, or written in the config file, so the code names no product
// beyond these two. Anything a site's entry sets overrides its preset.

export const PRESETS = {
  google: { type: 'google', id: 'google', label: 'Google' },

  slack: { type: 'slack', id: 'slack', label: 'Slack' },
};
