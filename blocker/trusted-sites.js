const browserApi = globalThis.browser ?? globalThis.chrome;
const LOG_PREFIX = '[BraveFox Focus Master Trusted Sites]';

const listeners = new Set();
let domains = new Set();
let pathRules = [];
let entries = [];
let status = {
  source: 'dataset',
  count: 0,
  lastUpdated: 0,
  lastError: ''
};

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/^https?:\/\//i, '')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^www\./, '');
}

function normalizePathPrefix(value) {
  let path = String(value || '/').trim();
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  return path || '/';
}

function usesCaseInsensitivePaths(host) {
  const normalizedHost = normalizeHost(host);
  return normalizedHost === 'reddit.com' || normalizedHost.endsWith('.reddit.com');
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function csvField(value) {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function descriptorFromFields(typeValue, hostValue, pathValue = '') {
  const type = String(typeValue || '').trim().toLocaleLowerCase('en-US');
  const host = normalizeHost(hostValue);
  if (!host || (!host.includes('.') && host !== 'localhost')) return null;

  if (type === 'domain') {
    return { type: 'domain', host, pathPrefix: '', entry: `domain,${host}` };
  }
  if (type === 'path') {
    const pathPrefix = normalizePathPrefix(pathValue);
    if (pathPrefix === '/') return { type: 'domain', host, pathPrefix: '', entry: `domain,${host}` };
    return { type: 'path', host, pathPrefix, entry: `path,${host},${pathPrefix}` };
  }
  return null;
}

export function parseTrustedSiteEntry(value) {
  if (value && typeof value === 'object') {
    return descriptorFromFields(value.type, value.host, value.pathPrefix || value.path || '');
  }

  const raw = String(value ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw || raw.startsWith('#')) return null;

  const fields = parseCsvLine(raw);
  const first = String(fields[0] || '').toLocaleLowerCase('en-US');
  if (first === 'type' && String(fields[1] || '').toLocaleLowerCase('en-US') === 'host') return null;
  if (first === 'domain') return descriptorFromFields(first, fields[1], fields[2]);
  if (first === 'path') {
    // Backward compatibility: older hand-edited TrustedSites.csv files could
    // contain path rows as `path,example.com/some/path` with the host and
    // path accidentally combined into the second CSV field. Recover that
    // shape on import so the next export/GitHub upload self-heals it.
    const hostField = String(fields[1] || '').trim();
    const pathField = String(fields[2] || '').trim();
    if (!pathField && /[\/?#]/.test(hostField)) {
      try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(hostField) ? hostField : `https://${hostField}`);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return descriptorFromFields('path', parsed.hostname, parsed.pathname || '/');
        }
      } catch {
        // Fall through to the normal CSV-field parser below.
      }
    }
    return descriptorFromFields(first, fields[1], fields[2]);
  }

  // Friendly input: a plain domain, domain/path, or full URL.
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = normalizeHost(parsed.hostname);
    const pathPrefix = normalizePathPrefix(parsed.pathname || '/');
    return descriptorFromFields(pathPrefix === '/' ? 'domain' : 'path', host, pathPrefix);
  } catch {
    return null;
  }
}

export function normalizeTrustedSiteEntry(value) {
  return parseTrustedSiteEntry(value)?.entry || '';
}

export function parseTrustedSitesCsv(text) {
  const nextEntries = [];
  const seen = new Set();
  const nextDomains = new Set();
  const nextPaths = [];

  for (const rawLine of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const descriptor = parseTrustedSiteEntry(rawLine);
    if (!descriptor || seen.has(descriptor.entry)) continue;
    seen.add(descriptor.entry);
    nextEntries.push(descriptor.entry);
    if (descriptor.type === 'domain') nextDomains.add(descriptor.host);
    else nextPaths.push({ host: descriptor.host, pathPrefix: descriptor.pathPrefix });
  }

  return { entries: nextEntries, domains: [...nextDomains], pathRules: nextPaths };
}

export function serializeTrustedSitesCsv(values) {
  const domains = [];
  const paths = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const descriptor = parseTrustedSiteEntry(value);
    if (!descriptor || seen.has(descriptor.entry)) continue;
    seen.add(descriptor.entry);
    if (descriptor.type === 'domain') domains.push(descriptor);
    else paths.push(descriptor);
  }

  // Keep the on-disk/GitHub file human-readable as well as machine-readable.
  // The parser already ignores blank lines and # comments, so these section
  // headings round-trip cleanly without becoming trusted-site rules.
  const rows = ['type,host,path', '', '# DOMAINS'];
  for (const descriptor of domains) {
    rows.push(`domain,${csvField(descriptor.host)},`);
  }
  rows.push('', '# PATHS');
  for (const descriptor of paths) {
    rows.push(`path,${csvField(descriptor.host)},${csvField(descriptor.pathPrefix)}`);
  }
  return `${rows.join('\r\n')}\r\n`;
}

function pathPrefixMatches(pathname, prefix, { caseInsensitive = false } = {}) {
  let path = String(pathname || '/').replace(/\/{2,}/g, '/');
  let normalized = normalizePathPrefix(prefix);
  if (caseInsensitive) {
    path = path.toLocaleLowerCase('en-US');
    normalized = normalized.toLocaleLowerCase('en-US');
  }
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function applyTrustedSiteEntries(values, nextStatus = {}) {
  const parsed = parseTrustedSitesCsv((Array.isArray(values) ? values : []).join('\n'));
  entries = parsed.entries;
  domains = new Set(parsed.domains);
  pathRules = parsed.pathRules;
  status = {
    source: String(nextStatus.source || 'dataset'),
    count: entries.length,
    lastUpdated: Number(nextStatus.lastUpdated) || Date.now(),
    lastError: String(nextStatus.lastError || '')
  };

  for (const listener of listeners) {
    try {
      listener(getTrustedSiteDescriptors(), getTrustedSitesStatus());
    } catch (error) {
      console.warn(LOG_PREFIX, error);
    }
  }
  return getTrustedSitesStatus();
}

export async function initializeTrustedSites(values = null) {
  if (Array.isArray(values)) applyTrustedSiteEntries(values, { source: 'dataset' });
  return getTrustedSitesStatus();
}

// Kept as a compatibility hook for older callers. GitHub refreshes now flow
// through the unified four-list dataset instead of this module fetching on its own.
export async function refreshTrustedSites() {
  return getTrustedSitesStatus();
}

export function isTrustedHostname(value) {
  const host = normalizeHost(value);
  if (!host) return false;
  if (/^translate\.google\./i.test(host)) return true;
  for (const domain of domains) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

export function isTrustedUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = normalizeHost(parsed.hostname);
    if (isTrustedHostname(host)) return true;
    return pathRules.some(rule =>
      host === rule.host &&
      pathPrefixMatches(parsed.pathname, rule.pathPrefix, { caseInsensitive: usesCaseInsensitivePaths(host) })
    );
  } catch {
    return false;
  }
}

export function getTrustedSiteEntries() {
  return [...entries];
}

export function getTrustedSiteDescriptors() {
  return { domains: [...domains], pathRules: pathRules.map(rule => ({ ...rule })) };
}

export function getTrustedSitesStatus() {
  return { ...status };
}

export function onTrustedSitesChanged(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Avoid an unused-global warning in Firefox builds where `browserApi` is only
// needed for compatibility with older bundled variants.
void browserApi;
