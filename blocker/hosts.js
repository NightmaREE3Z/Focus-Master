import { browser } from './api.js';
import { isCompletelyExcludedHostname, isCompletelyExcludedUrl } from './shared.js';

const LOG_PREFIX = '[BraveFox Focus Master Hosts]';
const META_KEY = 'bfb:hosts-meta:v1';
const CHUNK_PREFIX = 'bfb:hosts-chunk:v1:';
const ALARM_NAME = 'bfb-hosts-refresh';
const CHUNK_SIZE = 5000;
const SOURCES = [
  { id: 'BraveFoxHosts', url: 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/BraveFoxHosts', fallbackPath: 'blocker/lists/BraveFoxHosts' },
  { id: 'StevenBlack', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-porn/hosts' },
  { id: 'legacyFox', url: 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/legacyFox', fallbackPath: 'blocker/lists/legacyFox' }
];

let cachedHosts = null;
let updatePromise = null;

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

function isIPAddress(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':');
}

function parseHostsText(text) {
  const result = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const candidate = normalizeHost(parts.length > 1 ? parts[1] : parts[0]);
    if (!candidate || candidate === 'localhost' || isIPAddress(candidate) || !candidate.includes('.')) continue;
    result.push(candidate);
  }
  return result;
}

async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'text/plain' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchSource(source) {
  try {
    return parseHostsText(await fetchText(`${source.url}?bravefox_refresh=${Date.now()}`));
  } catch (remoteError) {
    if (!source.fallbackPath) {
      console.warn(`${LOG_PREFIX} ${source.id} unavailable:`, remoteError);
      return [];
    }
    try {
      return parseHostsText(await fetchText(browser.runtime.getURL(source.fallbackPath)));
    } catch (fallbackError) {
      console.warn(`${LOG_PREFIX} ${source.id} remote and bundled fallback failed:`, fallbackError);
      return [];
    }
  }
}

async function saveHosts(hosts) {
  const old = await browser.storage.local.get(null);
  const oldKeys = Object.keys(old).filter(key => key.startsWith(CHUNK_PREFIX));
  const payload = {};
  let chunks = 0;
  for (let index = 0; index < hosts.length; index += CHUNK_SIZE) {
    payload[`${CHUNK_PREFIX}${chunks}`] = hosts.slice(index, index + CHUNK_SIZE);
    chunks += 1;
  }
  payload[META_KEY] = { chunks, count: hosts.length, updatedAt: Date.now() };
  await browser.storage.local.set(payload);
  const keep = new Set(Object.keys(payload));
  const stale = oldKeys.filter(key => !keep.has(key));
  if (stale.length) await browser.storage.local.remove(stale);
}

async function loadHosts() {
  const metaResult = await browser.storage.local.get(META_KEY);
  const meta = metaResult[META_KEY];
  if (!meta?.chunks) return [];
  const keys = Array.from({ length: Number(meta.chunks) }, (_, index) => `${CHUNK_PREFIX}${index}`);
  const data = await browser.storage.local.get(keys);
  const hosts = [];
  for (const key of keys) {
    if (Array.isArray(data[key])) hosts.push(...data[key]);
  }
  return hosts;
}

export async function updateHosts() {
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    const seen = new Set();
    for (const source of SOURCES) {
      const values = await fetchSource(source);
      for (const host of values) {
        if (!isCompletelyExcludedHostname(host) && !seen.has(host)) seen.add(host);
      }
    }
    if (!seen.size) {
      const existing = cachedHosts || await loadHosts();
      if (existing.length) return existing;
      throw new Error('No hosts source or bundled fallback could be loaded.');
    }
    const hosts = [...seen].sort();
    await saveHosts(hosts);
    cachedHosts = hosts;
    return hosts;
  })().finally(() => { updatePromise = null; });
  return updatePromise;
}

async function ensureHosts() {
  if (cachedHosts) return cachedHosts;
  cachedHosts = await loadHosts();
  if (!cachedHosts.length) cachedHosts = await updateHosts();
  return cachedHosts;
}

function binaryHas(sorted, value) {
  let low = 0, high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const current = sorted[mid];
    if (current === value) return true;
    if (current < value) low = mid + 1; else high = mid - 1;
  }
  return false;
}

export async function findBlockedHost(urlValue) {
  if (isCompletelyExcludedUrl(urlValue)) return '';
  let host;
  try { host = normalizeHost(new URL(String(urlValue || '')).hostname); } catch { return ''; }
  if (!host) return '';
  const hosts = await ensureHosts();
  const labels = host.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join('.');
    if (binaryHas(hosts, candidate)) return candidate;
  }
  return '';
}

export async function initializeHosts() {
  try { cachedHosts = await loadHosts(); } catch {}
  browser.alarms.create(ALARM_NAME, { periodInMinutes: 60 });
  void updateHosts().catch(error => console.warn(`${LOG_PREFIX} Refresh failed; cached/bundled hosts remain active:`, error));
}

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) void updateHosts().catch(error => console.warn(`${LOG_PREFIX} Refresh failed:`, error));
});
