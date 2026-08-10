import {
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

function normalizeRuleHost(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

function normalizeRulePath(value) {
  let path = String(value || '/').trim().toLocaleLowerCase('en-US') || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  return path;
}

function normalizeQueryValue(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US');
}

function parsedCandidate(urlValue) {
  const url = new URL(urlValue);
  const host = normalizeRuleHost(url.hostname);
  return { url, host };
}

function parseStructuredLinkRule(stored) {
  const raw = String(stored || '').trim();
  if (!raw || raw.includes('*')) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = normalizeRuleHost(url.hostname);
    if (!host) return null;
    const path = normalizeRulePath(url.pathname);
    const query = [];
    for (const [key, value] of url.searchParams.entries()) {
      query.push({
        key: String(key || '').toLocaleLowerCase('en-US'),
        value: normalizeQueryValue(value)
      });
    }
    return {
      host,
      path,
      hasPath: path !== '/',
      query,
      hasQuery: query.length > 0,
      wholeHost: path === '/' && query.length === 0
    };
  } catch {
    return null;
  }
}

function pathRuleMatches(candidatePath, rulePath) {
  const path = normalizeRulePath(candidatePath);
  const prefix = normalizeRulePath(rulePath);
  if (prefix === '/') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function candidateQueryMap(url) {
  const map = new Map();
  for (const [rawKey, rawValue] of url.searchParams.entries()) {
    const key = String(rawKey || '').toLocaleLowerCase('en-US');
    const values = map.get(key) || [];
    values.push(normalizeQueryValue(rawValue));
    map.set(key, values);
  }
  return map;
}

function queryRuleMatches(candidateUrl, ruleEntries) {
  if (!ruleEntries.length) return true;
  const candidate = candidateQueryMap(candidateUrl);
  for (const rule of ruleEntries) {
    const values = candidate.get(rule.key);
    if (!values?.length) return false;
    // A valueless rule such as "&top" means the parameter merely has to exist.
    if (rule.value && !values.includes(rule.value)) return false;
  }
  return true;
}

function structuredLinkRuleMatches(candidate, rule) {
  if (!hostMatches(candidate.host, rule.host)) return false;
  if (rule.hasPath && !pathRuleMatches(candidate.url.pathname, rule.path)) return false;
  return queryRuleMatches(candidate.url, rule.query);
}

export function matchLink(urlValue, links) {
  if (!isSupportedWebUrl(urlValue)) return null;
  let candidate;
  try {
    candidate = parsedCandidate(urlValue);
  } catch {
    return null;
  }

  for (const stored of links) {
    const raw = String(stored || '').trim();
    if (!raw) continue;

    if (raw.includes('*')) {
      const canonical = `${candidate.host}${candidate.url.pathname === '/' ? '' : normalizeRulePath(candidate.url.pathname)}${candidate.url.search || ''}`
        .toLocaleLowerCase('en-US');
      const normalizedRule = raw
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .toLocaleLowerCase('en-US');
      if (wildcardRegex(normalizedRule).test(canonical)) return stored;
      continue;
    }

    const rule = parseStructuredLinkRule(raw);
    if (rule && structuredLinkRuleMatches(candidate, rule)) return stored;
  }
  return null;
}

// A host with path/query-specific Blocker link rules is intentionally under
// surgical control. In that case the blunt fetched-hosts layer must not block
// the whole host. Adding a bare host rule (for example "xvideos.com") still
// wins at the Blocker Links tier before this helper is consulted.
export function hasScopedLinkRulesForUrl(urlValue, links) {
  if (!isSupportedWebUrl(urlValue)) return false;
  let candidate;
  try {
    candidate = parsedCandidate(urlValue);
  } catch {
    return false;
  }

  let hasSpecificRule = false;
  for (const stored of links) {
    const rule = parseStructuredLinkRule(stored);
    if (!rule || !hostMatches(candidate.host, rule.host)) continue;
    if (rule.wholeHost) return false;
    if (rule.hasPath || rule.hasQuery) hasSpecificRule = true;
  }
  return hasSpecificRule;
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
  return candidate.includes(token);
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
  if (!isSupportedWebUrl(url)) return null;
  const candidates = extractTermCandidates({ url, title });
  if (!candidates.length) return null;

  for (const stored of terms) {
    if (candidates.some(candidate => termMatchesCandidate(candidate, stored))) return stored;
  }
  return null;
}

export function findBlockReason({ url, title = '' }, dataset, settings) {
  if (!settings.enabled || !isSupportedWebUrl(url)) return null;
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
