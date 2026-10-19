// A set of site definitions, with the lookups the rest of the extension needs. The engine,
// background, popup and options all take a registry rather than a fixed list, so the sites can
// come from configuration.

// Manifest-style match pattern: * matches anything, the rest literally.
export function matchesPattern(pattern, url) {
  const literal = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${literal.join('.*')}$`).test(url);
}

export function createRegistry(sites) {
  const byId = new Map(sites.map((site) => [site.id, site]));
  return {
    sites,

    byId(id) {
      return byId.get(id) ?? null;
    },

    label(id) {
      return byId.get(id)?.label ?? id;
    },

    forUrl(url) {
      const href = String(url).split('#')[0];
      return sites.find((site) => site.matches.some((pattern) => matchesPattern(pattern, href))) ?? null;
    },

    // The Google loop (the site whose runs start on Google's own sign-in pages), if any.
    googleLoop: sites.find((site) => site.googleItself) ?? null,

    // The site whose signed-in status the badge shows (✓/✗), if any.
    tracked: sites.find((site) => site.tracksSignIn) ?? null,

    // Every site's origin, for "Sign out of all". Clearing cookies for an origin clears its whole
    // registrable domain: accounts.google.com means all of google.com.
    origins() {
      const origins = sites.flatMap((site) => site.matches.map((pattern) => new URL(pattern.replace(/\*/g, '')).origin));
      return [...new Set(origins)];
    },

    // The host access a site needs ("https://host/*" for each origin of its pages). Google's own
    // pages are covered by the manifest; every other site's access is granted at runtime.
    accessFor(site) {
      if (site.googleItself) return [];
      return [...new Set(site.matches.map((pattern) => `${new URL(pattern.replace(/\*/g, 'x')).origin}/*`))];
    },

    // In alphabetical order of their labels, for lists people read.
    byLabel() {
      return [...sites].sort((a, b) => a.label.localeCompare(b.label));
    },
  };
}
