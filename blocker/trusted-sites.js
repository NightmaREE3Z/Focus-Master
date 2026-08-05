import { COMPLETE_EXCLUSION_HOSTS, COMPLETE_EXCLUSION_PATH_RULES } from './constants.js';

const browserApi = globalThis.browser ?? globalThis.chrome;
const LOG_PREFIX = '[BraveFox Focus Master Trusted Sites]';
const REMOTE_URL = 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/TrustedSites.csv';
const BUNDLED_PATH = 'blocker/lists/TrustedSites.csv';
const CACHE_KEY = 'bfb:trusted-sites-cache:v1';
const STATUS_KEY = 'bfb:trusted-sites-status:v1';
const ALARM_NAME = 'bfb-trusted-sites-refresh';
const REFRESH_MINUTES = 15;
const MIN_VALID_ENTRIES = 20;

const listeners = new Set();
let initializedPromise = null;
let domains = new Set(COMPLETE_EXCLUSION_HOSTS.map(normalizeHost).filter(Boolean));
let pathRules = COMPLETE_EXCLUSION_PATH_RULES.map(rule => ({
  host: normalizeHost(rule.host),
  pathPrefix: normalizePathPrefix(rule.pathPrefix)
})).filter(rule => rule.host && rule.pathPrefix);
let status = {
  source: 'compiled-fallback',
  count: domains.size + pathRules.length,
  lastUpdated: 0,
  lastError: ''
};

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '').replace(/^www\./, '');
}

function normalizePathPrefix(value) {
  let path = String(value || '/').trim();
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return path || '/';
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(current.trim()); current = '';
    } else current += char;
  }
  fields.push(current.trim());
  return fields;
}

export function parseTrustedSitesCsv(text) {
  const nextDomains = new Set();
  const nextPaths = [];
  const pathKeys = new Set();
  for (const rawLine of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = parseCsvLine(line);
    const type = String(fields[0] || '').toLowerCase();
    if (type === 'type' && String(fields[1] || '').toLowerCase() === 'host') continue;
    if (type === 'domain') {
      const host = normalizeHost(fields[1]);
      if (host && host.includes('.')) nextDomains.add(host);
      continue;
    }
    if (type === 'path') {
      const host = normalizeHost(fields[1]);
      const pathPrefix = normalizePathPrefix(fields[2]);
      const key = `${host}\n${pathPrefix}`;
      if (host && host.includes('.') && !pathKeys.has(key)) {
        pathKeys.add(key);
        nextPaths.push({ host, pathPrefix });
      }
      continue;
    }
    // Friendly single-column fallback: a plain domain per line is accepted.
    if (fields.length === 1) {
      const host = normalizeHost(fields[0]);
      if (host && host.includes('.')) nextDomains.add(host);
    }
  }
  const count = nextDomains.size + nextPaths.length;
  if (count < MIN_VALID_ENTRIES) throw new Error(`TrustedSites.csv contains only ${count} valid entries.`);
  return { domains: [...nextDomains], pathRules: nextPaths };
}

function pathPrefixMatches(pathname, prefix) {
  const path = String(pathname || '/').replace(/\/{2,}/g, '/');
  const normalized = normalizePathPrefix(prefix);
  return path === normalized || path.startsWith(`${normalized}/`);
}

function applyTrustedSites(data, nextStatus) {
  domains = new Set((data?.domains || []).map(normalizeHost).filter(Boolean));
  pathRules = (data?.pathRules || []).map(rule => ({
    host: normalizeHost(rule.host),
    pathPrefix: normalizePathPrefix(rule.pathPrefix)
  })).filter(rule => rule.host && rule.pathPrefix);
  status = {
    source: String(nextStatus?.source || 'unknown'),
    count: domains.size + pathRules.length,
    lastUpdated: Number(nextStatus?.lastUpdated) || Date.now(),
    lastError: String(nextStatus?.lastError || '')
  };
  for (const listener of listeners) {
    try { listener(getTrustedSiteDescriptors(), getTrustedSitesStatus()); } catch (error) { console.warn(LOG_PREFIX, error); }
  }
}

async function fetchText(url) {
  const separator = url.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${separator}bravefox_refresh=${Date.now()}`, {
    cache: 'no-store', credentials: 'omit', headers: { Accept: 'text/plain' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function readCache() {
  try {
    const result = await browserApi.storage.local.get(CACHE_KEY);
    const record = result[CACHE_KEY];
    if (!record?.csv) return null;
    return { data: parseTrustedSitesCsv(record.csv), updatedAt: Number(record.updatedAt) || 0 };
  } catch { return null; }
}

async function readBundled() {
  const response = await fetch(browserApi.runtime.getURL(BUNDLED_PATH), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Bundled TrustedSites.csv failed (HTTP ${response.status}).`);
  const csv = await response.text();
  return { csv, data: parseTrustedSitesCsv(csv) };
}

async function writeStatus() {
  try { await browserApi.storage.local.set({ [STATUS_KEY]: status }); } catch {}
}

export async function refreshTrustedSites({ reason = 'automatic' } = {}) {
  let remoteError = null;
  try {
    const csv = await fetchText(REMOTE_URL);
    const data = parseTrustedSitesCsv(csv);
    const now = Date.now();
    await browserApi.storage.local.set({ [CACHE_KEY]: { csv, updatedAt: now } });
    applyTrustedSites(data, { source: 'github', lastUpdated: now, lastError: '' });
    await writeStatus();
    return getTrustedSitesStatus();
  } catch (error) {
    remoteError = error;
  }

  const cached = await readCache();
  if (cached) {
    applyTrustedSites(cached.data, {
      source: 'last-known-good-cache',
      lastUpdated: cached.updatedAt,
      lastError: `GitHub refresh failed during ${reason}: ${String(remoteError?.message || remoteError)}`
    });
    await writeStatus();
    return getTrustedSitesStatus();
  }

  try {
    const bundled = await readBundled();
    applyTrustedSites(bundled.data, {
      source: 'bundled-fallback',
      lastUpdated: Date.now(),
      lastError: `GitHub refresh failed during ${reason}: ${String(remoteError?.message || remoteError)}`
    });
    await writeStatus();
    return getTrustedSitesStatus();
  } catch (fallbackError) {
    status = {
      ...status,
      source: 'compiled-fallback',
      lastError: `Remote, cached and bundled trusted-site loading failed: ${String(fallbackError?.message || fallbackError)}`
    };
    await writeStatus();
    return getTrustedSitesStatus();
  }
}

export async function initializeTrustedSites() {
  if (initializedPromise) return initializedPromise;
  initializedPromise = (async () => {
    const result = await refreshTrustedSites({ reason: 'startup' });
    browserApi.alarms?.create?.(ALARM_NAME, { periodInMinutes: REFRESH_MINUTES });
    return result;
  })();
  return initializedPromise;
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
    return pathRules.some(rule => host === rule.host && pathPrefixMatches(parsed.pathname, rule.pathPrefix));
  } catch { return false; }
}

export function getTrustedSiteDescriptors() {
  return { domains: [...domains], pathRules: pathRules.map(rule => ({ ...rule })) };
}

export function getTrustedSitesStatus() { return { ...status, remoteUrl: REMOTE_URL }; }

export function onTrustedSitesChanged(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

browserApi.alarms?.onAlarm?.addListener?.(alarm => {
  if (alarm?.name !== ALARM_NAME) return;
  void refreshTrustedSites({ reason: 'scheduled refresh' }).catch(error => console.warn(LOG_PREFIX, error));
});

browserApi.runtime?.onStartup?.addListener?.(() => { void initializeTrustedSites(); });
browserApi.runtime?.onInstalled?.addListener?.(() => { void initializeTrustedSites(); });
