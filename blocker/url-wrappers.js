// BraveFox Focus Master archive/proxy URL unwrapping — 2026-08-21
//
// A blocked destination must remain blocked when it is carried through a
// known archive, reader, translation or cache wrapper that exposes the real
// target in its own URL. Only deterministic, URL-visible targets are unwrapped;
// opaque snapshot IDs cannot be safely guessed here.

const MAX_UNWRAP_DEPTH = 5;
const MAX_CANDIDATES = 12;

function lowerHost(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US').replace(/\.$/, '');
}

function decodeRepeated(value) {
  let output = String(value || '').trim();
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(output);
      if (decoded === output) break;
      output = decoded;
    } catch {
      break;
    }
  }
  return output.trim();
}

function normalizeTargetCandidate(value) {
  let raw = decodeRepeated(value)
    .replace(/^\/+/, match => match.length >= 2 ? '//' : '')
    .trim();
  if (!raw) return '';

  // Strip a few common archive decorations that can precede the embedded URL.
  raw = raw.replace(/^(?:id_|im_|if_|oe_|js_|cs_)\//i, '');

  if (/^\/\//.test(raw)) raw = `https:${raw}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // Wayback wildcard URLs commonly store only host/path after the capture token.
    if (/^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(raw)) {
      raw = `https://${raw}`;
    } else {
      return '';
    }
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function embeddedHttpTargets(text) {
  const decoded = decodeRepeated(text);
  const results = [];
  const regex = /https?:\/\/[^\s"'<>]+/ig;
  for (const match of decoded.matchAll(regex)) {
    const normalized = normalizeTargetCandidate(match[0]);
    if (normalized) results.push(normalized);
  }
  return results;
}

function queryTargets(url, keys) {
  const wanted = new Set(keys.map(key => String(key).toLocaleLowerCase('en-US')));
  const output = [];
  for (const [rawKey, rawValue] of url.searchParams.entries()) {
    const key = String(rawKey || '').toLocaleLowerCase('en-US');
    if (!wanted.has(key)) continue;

    const value = decodeRepeated(rawValue);
    const direct = normalizeTargetCandidate(value.replace(/^cache:[^:]*:/i, ''));
    if (direct) output.push(direct);
    output.push(...embeddedHttpTargets(value));
  }
  return output;
}

function isGoogleTranslateWrapper(host, pathname) {
  return /^translate\.google\.[a-z0-9.-]+$/i.test(host) && pathname === '/translate';
}

export const UNSUPPORTED_ARCHIVE_HOSTS = Object.freeze([
  'archive.ph',
  'archive.today',
  'archive.is',
  'archive.li',
  'archive.vn',
  'archive.md',
  'archive.fo'
]);

function hostMatchesUnsupportedArchive(host) {
  const normalized = lowerHost(host);
  return UNSUPPORTED_ARCHIVE_HOSTS.some(
    blockedHost => normalized === blockedHost || normalized.endsWith(`.${blockedHost}`)
  );
}

export function isUnsupportedArchiveUrl(urlValue) {
  try {
    const url = new URL(String(urlValue || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return hostMatchesUnsupportedArchive(url.hostname);
  } catch {
    return false;
  }
}

function isArchiveTodayHost(host) {
  return hostMatchesUnsupportedArchive(host);
}

function extractWaybackTargets(url) {
  const output = [];
  const path = decodeRepeated(url.pathname || '/');

  // Standard Wayback shapes:
  // /web/<timestamp-or-wildcard>/<url>
  // /web/<timestamp>id_/https://example.com/
  const webMatch = /^\/web\/[^/]+\/(.+)$/i.exec(path);
  if (webMatch) {
    const direct = normalizeTargetCandidate(webMatch[1]);
    if (direct) output.push(direct);
    output.push(...embeddedHttpTargets(webMatch[1]));
  }

  const saveMatch = /^\/save\/(.+)$/i.exec(path);
  if (saveMatch) {
    const direct = normalizeTargetCandidate(saveMatch[1]);
    if (direct) output.push(direct);
    output.push(...embeddedHttpTargets(saveMatch[1]));
  }

  // Archive-It and several Memento-compatible mirrors put an explicit URL
  // later in the path even when their leading path structure differs.
  output.push(...embeddedHttpTargets(path));
  output.push(...queryTargets(url, ['url', 'u', 'target', 'uri']));
  return output;
}

function extractWrapperTargets(url) {
  const host = lowerHost(url.hostname);
  const path = decodeRepeated(url.pathname || '/');
  const output = [];

  if (host === 'web.archive.org' || host.endsWith('.archive-it.org')) {
    output.push(...extractWaybackTargets(url));
  } else if (host === 'r.jina.ai') {
    const direct = normalizeTargetCandidate(path.replace(/^\//, ''));
    if (direct) output.push(direct);
    output.push(...embeddedHttpTargets(path));
  } else if (host === '12ft.io') {
    const direct = normalizeTargetCandidate(path.replace(/^\//, ''));
    if (direct) output.push(direct);
    output.push(...embeddedHttpTargets(path));
  } else if (isGoogleTranslateWrapper(host, path)) {
    output.push(...queryTargets(url, ['u', 'url']));
  } else if (host === 'webcache.googleusercontent.com') {
    output.push(...queryTargets(url, ['q', 'url', 'u']));
  } else if (host === 'arquivo.pt' || host.endsWith('.arquivo.pt')) {
    output.push(...embeddedHttpTargets(path));
    output.push(...queryTargets(url, ['url', 'u', 'target', 'uri']));
  } else if (host === 'timetravel.mementoweb.org' || host.endsWith('.mementoweb.org')) {
    output.push(...embeddedHttpTargets(path));
    output.push(...queryTargets(url, ['url', 'u', 'target', 'uri']));
  } else if (isArchiveTodayHost(host)) {
    const newestOldest = /^\/(?:newest|oldest)\/(.+)$/i.exec(path);
    if (newestOldest) {
      const direct = normalizeTargetCandidate(newestOldest[1]);
      if (direct) output.push(direct);
      output.push(...embeddedHttpTargets(newestOldest[1]));
    }
    output.push(...queryTargets(url, ['url', 'u', 'target', 'uri']));
  }

  return [...new Set(output)].filter(Boolean);
}

export function expandWrappedWebUrls(urlValue) {
  let root;
  try {
    root = new URL(String(urlValue || ''));
    if (root.protocol !== 'http:' && root.protocol !== 'https:') return [];
  } catch {
    return [];
  }

  const output = [];
  const seen = new Set();
  const queue = [{ url: root.href, depth: 0 }];

  while (queue.length && output.length < MAX_CANDIDATES) {
    const current = queue.shift();
    if (!current || seen.has(current.url)) continue;
    seen.add(current.url);
    output.push(current.url);
    if (current.depth >= MAX_UNWRAP_DEPTH) continue;

    let parsed;
    try { parsed = new URL(current.url); } catch { continue; }
    for (const target of extractWrapperTargets(parsed)) {
      if (!seen.has(target)) queue.push({ url: target, depth: current.depth + 1 });
    }
  }

  return output;
}

export function extractWrappedTargetUrls(urlValue) {
  return expandWrappedWebUrls(urlValue).slice(1);
}
