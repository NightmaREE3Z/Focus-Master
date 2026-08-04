import {
  isCompletelyExcludedUrl,
  isSupportedWebUrl,
  normalizeSearchable
} from './shared.js';

function wildcardRegex(value) {
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}(?:$|[/?#].*)`, 'i');
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
    const hostMatches = candidate.host === ruleHost || candidate.host.endsWith(`.${ruleHost}`);
    if (!hostMatches) continue;
    if (!ruleTail || candidate.canonical.startsWith(`${candidate.host}${ruleTail}`)) return stored;
  }
  return null;
}

export function extractAttemptedSearch(urlValue) {
  try {
    const url = new URL(urlValue);
    for (const key of ['q', 'query', 'search', 'text', 'p', 'keyword', 'term']) {
      const value = url.searchParams.get(key);
      if (value?.trim()) return value.trim();
    }
  } catch {}
  return '';
}

function singleTokenMatches(candidate, token) {
  if (token.length > 3) return candidate.includes(token);
  try {
    return new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`, 'i').test(candidate);
  } catch {
    return candidate.includes(token);
  }
}

export function matchTerm({ url, title = '' }, terms) {
  if (!isSupportedWebUrl(url) || isCompletelyExcludedUrl(url)) return null;
  const attemptedSearch = extractAttemptedSearch(url);
  const candidate = normalizeSearchable(`${attemptedSearch} ${url} ${title}`);
  if (!candidate) return null;

  for (const stored of terms) {
    const term = normalizeSearchable(stored);
    if (!term) continue;
    if (candidate.includes(term)) return stored;
    const tokens = term.split(' ').filter(Boolean);
    if (tokens.length > 1 && tokens.every(token => candidate.includes(token))) return stored;
    if (tokens.length === 1 && singleTokenMatches(candidate, tokens[0])) return stored;
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
