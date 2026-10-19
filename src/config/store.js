// Loading and saving the config (see schema.js) in chrome.storage.local. Used by the background
// worker, popup and options page.

import { DEFAULT_CONFIG, parseConfig } from './schema.js';
import { buildRegistry } from '../sites/build.js';

export async function loadConfig() {
  const { config } = await chrome.storage.local.get('config');
  const { config: parsed, errors } = parseConfig(config ?? DEFAULT_CONFIG);
  // Imports are checked before saving, so this only happens if the format changes under it.
  if (errors.length) console.warn('Auto sign-in: problems in the saved config', errors);
  return parsed;
}

export async function loadRegistry() {
  return buildRegistry(await loadConfig());
}

// Saves a config document as given (it's checked again on every load).
export async function saveConfig(raw) {
  await chrome.storage.local.set({ config: raw });
}
