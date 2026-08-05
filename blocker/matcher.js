import {
  isCompletelyExcludedUrl,
  isSupportedWebUrl,
  normalizeSearchable
} from './shared.js';

const GENERIC_SEARCH_KEYS = new Set([
  'q',
  'query',
  'search',
  'search_query',
  'searchquery',
  'keyword',
  'keywords',
  'term',
  'text',
  'p',
  'k',
  '_nkw',
  'wd',
  'query_text',
  'searchterm'
]);

const HOST_SEARCH_RULES = [
  { matches: host => isGoogleHost(host), keys: ['q'] },
  { matches: host => hostMatches(host, 'youtube.com'), keys: ['search_query'] },
  { matches: host => hostMatches(host, 'bing.com'), keys: ['q'] },
  { matches: host => hostMatches(host, 'duckduckgo.com'), keys: ['q'] },
  { matches: host => hostMatches(host, 'yahoo.com'), keys: ['p'] },
  { matches: host => host === 'search.brave.com', keys: ['q'] },
  { matches: host => hostMatches(host, 'startpage.com'), keys: ['query'] },
  { matches: host => hostMatches(host, 'ecosia.org'), keys: ['q'] },
  { matches: host => host === 'yandex.com' || /^yandex\.[a-z.]+$/i.test(host), keys: ['text'] },
  { matches: host => hostMatches(host, 'reddit.com'), keys: ['q'] },
  { matches: host => /^amazon\./i.test(stripCommonSubdomain(host)) || /\.amazon\./i.test(host), keys: ['k'] },
  { matches: host => /^ebay\./i.test(stripCommonSubdomain(host)) || /\.ebay\./i.test(host), keys: ['_nkw'] },
  { matches: host => hostMatches(host, 'github.com'), keys: ['q'] }
];

function wildcardRegex(value) {
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}(?:$|[/?#].*)`, 'i');
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function stripCommonSubdomain(host) {
  return host.replace(/^(?:www|m)\./i, '');
}

function isGoogleHost(host) {
  const value = stripCommonSubdomain(host);
  return /^google\.[a-z0-9.-]+$/i.test(value);
}

function parsedCandidate(urlValue) {
  const url = new URL(urlValue);
  const host = url.hostname.toLocaleLowerCase('en-US').replace(/^www\./, '').replace(/\.$/, '');
  const pathAndQuery = `${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}${url.search || ''}`;
  return { url, host, canonical: `${host}${pathAndQuery}`.toLocaleLowerCase('en-US') };
}

export function matchLink(urlValue, links) {
  if (!isSupportedWebUrl(urlValue) || isCompletelyExcludedUrl(urlValue)) return null;
  let candidate;
  try {
    candidate = parsedCandidate(urlValue);
  } catch {
    return null;
  }

  for (const stored of links) {
    const rule = String(stored || '').trim().toLocaleLowerCase('en-US');
    if (!rule) continue;

    if (rule.includes('*')) {
      if (wildcardRegex(rule).test(candidate.canonical)) return stored;
      continue;
    }

    const slash = rule.indexOf('/');
    const ruleHost = slash === -1 ? rule : rule.slice(0, slash);
    const ruleTail = slash === -1 ? '' : rule.slice(slash);
    const hostMatchesRule = candidate.host === ruleHost || candidate.host.endsWith(`.${ruleHost}`);
    if (!hostMatchesRule) continue;
    if (!ruleTail || candidate.canonical.startsWith(`${candidate.host}${ruleTail}`)) return stored;
  }
  return null;
}

function decodePathText(pathname) {
  if (!pathname || pathname === '/') return '';
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {}
  return decoded
    .replace(/[\/_+.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function valuesForKeys(url, keys) {
  const wanted = new Set(Array.from(keys, key => String(key).toLocaleLowerCase('en-US')));
  const values = [];
  for (const [rawKey, rawValue] of url.searchParams.entries()) {
    const key = rawKey.toLocaleLowerCase('en-US');
    const value = String(rawValue || '').trim();
    if (!value || !wanted.has(key)) continue;
    values.push(value);
  }
  return values;
}

function searchValuesForUrl(url) {
  const host = url.hostname.toLocaleLowerCase('en-US').replace(/\.$/, '');
  const rule = HOST_SEARCH_RULES.find(entry => entry.matches(host));
  if (rule) return valuesForKeys(url, rule.keys);

  // Generic fallback: inspect only well-known user-search fields. Everything else,
  // including utm_*, gclid, fbclid, ved, ei, feature and other tracker data, is ignored.
  return valuesForKeys(url, GENERIC_SEARCH_KEYS);
}

export function extractAttemptedSearch(urlValue) {
  try {
    const values = searchValuesForUrl(new URL(urlValue));
    return values[0] || '';
  } catch {
    return '';
  }
}

export function extractTermCandidates({ url, title = '' }) {
  try {
    const parsed = new URL(url);
    const searchValues = searchValuesForUrl(parsed)
      .map(value => String(value || '').trim())
      .filter(Boolean);

    // Search pages are intentionally matched only against their actual search field(s).
    // The raw URL, page title and tracking parameters must not contaminate the match.
    if (searchValues.length) return searchValues;

    const fields = [];
    const pathText = decodePathText(parsed.pathname);
    if (pathText) fields.push(pathText);

    const cleanTitle = String(title || '').trim();
    if (cleanTitle) fields.push(cleanTitle);

    return fields;
  } catch {
    return [];
  }
}

function tokenMatches(candidate, token) {
  if (token.length > 3) return candidate.includes(token);
  try {
    return new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`, 'i').test(candidate);
  } catch {
    return candidate.includes(token);
  }
}

function termMatchesCandidate(candidateValue, storedTerm) {
  const candidate = normalizeSearchable(candidateValue);
  const term = normalizeSearchable(storedTerm);
  if (!candidate || !term) return false;

  if (candidate.includes(term)) return true;

  const tokens = term.split(' ').filter(Boolean);
  if (tokens.length > 1) return tokens.every(token => tokenMatches(candidate, token));
  return tokens.length === 1 && tokenMatches(candidate, tokens[0]);
}

export function matchTerm({ url, title = '' }, terms) {
  if (!isSupportedWebUrl(url) || isCompletelyExcludedUrl(url)) return null;
  const candidates = extractTermCandidates({ url, title });
  if (!candidates.length) return null;

  for (const stored of terms) {
    if (candidates.some(candidate => termMatchesCandidate(candidate, stored))) return stored;
  }
  return null;
}

export function findBlockReason({ url, title = '' }, dataset, settings) {
  if (!settings.enabled || !isSupportedWebUrl(url) || isCompletelyExcludedUrl(url)) return null;
  if (settings.blockLinks) {
    const link = matchLink(url, dataset.links);
    if (link) return { type: 'link', trigger: link, attemptedSearch: extractAttemptedSearch(url) };
  }
  if (settings.blockTerms) {
    const term = matchTerm({ url, title }, dataset.terms);
    if (term) return { type: 'term', trigger: term, attemptedSearch: extractAttemptedSearch(url) };
  }
  return null;
}
