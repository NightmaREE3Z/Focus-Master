// Explicit, store-qualified listing rules only. Never scan arbitrary text for IDs.
// A Chrome/Edge extension ID is a 32-character [a-p] token. AMO and Opera
// detail URLs expose slugs; these are URL listing identifiers, not internal GUIDs.
const CRX_ID = /^[a-p]{32}$/;
const STORE_SLUG = /^[a-z0-9][a-z0-9._-]{0,149}$/;

export function extensionListingFromUrl(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(s => {
    try { return decodeURIComponent(s).toLowerCase(); } catch { return ''; }
  });
  let store = '', id = '';
  if (host === 'chromewebstore.google.com' && segments[0] === 'detail') {
    store = 'chrome'; id = segments[segments.length - 1] || '';
    if (segments.length < 2 || segments.length > 3 || !CRX_ID.test(id)) return null;
  } else if ((host === 'microsoftedge.microsoft.com' || host === 'edge.microsoft.com') &&
             segments[0] === 'addons' && segments[1] === 'detail') {
    store = 'edge'; id = segments[segments.length - 1] || '';
    if (segments.length < 3 || segments.length > 4 || !CRX_ID.test(id)) return null;
  } else if (host === 'addons.mozilla.org') {
    const index = segments.findIndex((part, i) => part === 'firefox' && segments[i + 1] === 'addon');
    if (index < 0 || index + 2 !== segments.length - 1) return null;
    store = 'amo'; id = segments[index + 2];
    if (!STORE_SLUG.test(id)) return null;
  } else if (host === 'addons.opera.com') {
    const index = segments.findIndex((part, i) => part === 'extensions' && segments[i + 1] === 'details');
    if (index < 0 || index + 2 !== segments.length - 1) return null;
    store = 'opera'; id = segments[index + 2];
    if (!STORE_SLUG.test(id)) return null;
  } else return null;
  return { store, id, rule: `${store}:${id}` };
}

// Chrome Web Store search phrases are part of the path, not ?q=.
// Only interpret searches on the real store origin; never scan a different
// site's URL or tracking parameters for store-scoped terms.
export function extensionSearchFromUrl(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { return null; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.hostname.toLowerCase() !== 'chromewebstore.google.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'search' || parts.length > 2) return null;
  let query = '';
  if (parts.length === 2) {
    try { query = decodeURIComponent(parts[1]); } catch { return null; }
  } else {
    query = url.searchParams.get('q') || '';
  }
  query = query.trim();
  return query ? { store: 'chrome', query } : null;
}

export function normalizeExtensionRule(value) {
  const raw = String(value ?? '').trim();
  const fromUrl = extensionListingFromUrl(raw);
  if (fromUrl) return fromUrl.rule;
  const match = /^(chrome|edge|amo|opera)\s*:\s*(.+)$/i.exec(raw);
  if (!match) return '';
  const store = match[1].toLowerCase(), id = match[2].trim().toLowerCase();
  if (store === 'chrome' || store === 'edge') return CRX_ID.test(id) ? `${store}:${id}` : '';
  return STORE_SLUG.test(id) ? `${store}:${id}` : '';
}

export function matchExtensionListing(url, rules) {
  const listing = extensionListingFromUrl(url);
  if (!listing) return null;
  return (Array.isArray(rules) ? rules : []).some(rule => normalizeExtensionRule(rule) === listing.rule)
    ? listing.rule : null;
}
