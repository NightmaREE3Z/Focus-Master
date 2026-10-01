import { browser } from './api.js';
import { isCompletelyExcludedHostname, isCompletelyExcludedUrl } from './shared.js';

const LOG_PREFIX = '[BraveFox Focus Master Hosts]';
const HARD_META_KEY = 'bfb:hard-hosts-meta:v1';
const HARD_CHUNK_PREFIX = 'bfb:hard-hosts-chunk:v1:';
const META_KEY = 'bfb:hosts-meta:v2';
const CHUNK_PREFIX = 'bfb:hosts-chunk:v2:';
const ALARM_NAME = 'bfb-hosts-refresh';
const CHUNK_SIZE = 5000;
const HARD_SOURCES = [
  { id: 'BraveFoxHosts', url: 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/BraveFoxHosts', fallbackPath: 'blocker/lists/BraveFoxHosts' },
  { id: 'legacyFox', url: 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/legacyFox', fallbackPath: 'blocker/lists/legacyFox' }
];
const SOURCES = [
  { id: 'StevenBlack', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-porn/hosts' }
];

let cachedHardHosts = null;
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

async function fetchRemoteSource(source) {
  try {
    return { ok: true, values: parseHostsText(await fetchText(`${source.url}?bravefox_refresh=${Date.now()}`)) };
  } catch (error) {
    console.warn(`${LOG_PREFIX} ${source.id} unavailable:`, error);
    return { ok: false, values: [] };
  }
}

async function fetchBundledFallback(source) {
  if (!source.fallbackPath) return { ok: false, values: [] };
  try {
    return { ok: true, values: parseHostsText(await fetchText(browser.runtime.getURL(source.fallbackPath))) };
  } catch (error) {
    console.warn(`${LOG_PREFIX} ${source.id} bundled fallback failed:`, error);
    return { ok: false, values: [] };
  }
}

async function saveHosts(hosts, metaKey = META_KEY, chunkPrefix = CHUNK_PREFIX) {
  const old = await browser.storage.local.get(null);
  const oldKeys = Object.keys(old).filter(key => key.startsWith(chunkPrefix));
  const payload = {};
  let chunks = 0;
  for (let index = 0; index < hosts.length; index += CHUNK_SIZE) {
    payload[`${chunkPrefix}${chunks}`] = hosts.slice(index, index + CHUNK_SIZE);
    chunks += 1;
  }
  payload[metaKey] = { chunks, count: hosts.length, updatedAt: Date.now() };
  await browser.storage.local.set(payload);
  const keep = new Set(Object.keys(payload));
  const stale = oldKeys.filter(key => !keep.has(key));
  if (stale.length) await browser.storage.local.remove(stale);
}

async function loadHosts(metaKey = META_KEY, chunkPrefix = CHUNK_PREFIX) {
  const metaResult = await browser.storage.local.get(metaKey);
  const meta = metaResult[metaKey];
  if (!meta?.chunks) return [];
  const keys = Array.from({ length: Number(meta.chunks) }, (_, index) => `${chunkPrefix}${index}`);
  const data = await browser.storage.local.get(keys);
  const hosts = [];
  for (const key of keys) {
    if (Array.isArray(data[key])) hosts.push(...data[key]);
  }
  return hosts;
}

async function updateSourceGroup(sources, existing, metaKey, chunkPrefix, label, required = true, respectTrusted = true) {
  const seen = new Set();
  let failed = false;
  for (const source of sources) {
    let result = await fetchRemoteSource(source);
    if (!result.ok && !existing.length) result = await fetchBundledFallback(source);
    if (!result.ok) {
      failed = true;
      continue;
    }
    for (const host of result.values) {
      if ((!respectTrusted || !isCompletelyExcludedHostname(host)) && !seen.has(host)) seen.add(host);
    }
  }
  if (failed && existing.length) {
    console.warn(`${LOG_PREFIX} ${label} refresh was incomplete; keeping the previous cached set.`);
    return existing;
  }
  if (!seen.size) {
    if (failed && required) throw new Error(`No ${label} hosts source or bundled fallback could be loaded.`);
    await saveHosts([], metaKey, chunkPrefix);
    return [];
  }
  const hosts = [...seen].sort();
  await saveHosts(hosts, metaKey, chunkPrefix);
  return hosts;
}

export async function updateHosts() {
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    const existingHardHosts = cachedHardHosts || await loadHosts(HARD_META_KEY, HARD_CHUNK_PREFIX);
    const existingHosts = cachedHosts || await loadHosts();
    cachedHardHosts = await updateSourceGroup(HARD_SOURCES, existingHardHosts, HARD_META_KEY, HARD_CHUNK_PREFIX, 'hard-block', true, false);
    cachedHosts = await updateSourceGroup(SOURCES, existingHosts, META_KEY, CHUNK_PREFIX, 'supplemental', false);
    return { hardHosts: cachedHardHosts, hosts: cachedHosts };
  })().finally(() => { updatePromise = null; });
  return updatePromise;
}

async function ensureHardHosts() {
  if (cachedHardHosts) return cachedHardHosts;
  cachedHardHosts = await loadHosts(HARD_META_KEY, HARD_CHUNK_PREFIX);
  if (!cachedHardHosts.length) {
    await updateHosts();
    cachedHardHosts = cachedHardHosts || [];
  }
  return cachedHardHosts;
}

async function ensureHosts() {
  if (cachedHosts) return cachedHosts;
  cachedHosts = await loadHosts();
  if (!cachedHosts.length) {
    await updateHosts();
    cachedHosts = cachedHosts || [];
  }
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

async function findBlockedHostInList(urlValue, hosts, respectTrusted = true) {
  if (respectTrusted && isCompletelyExcludedUrl(urlValue)) return '';
  let host;
  try { host = normalizeHost(new URL(String(urlValue || '')).hostname); } catch { return ''; }
  if (!host) return '';
  const labels = host.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join('.');
    if (binaryHas(hosts, candidate)) return candidate;
  }
  return '';
}

export async function findHardBlockedHost(urlValue) {
  return findBlockedHostInList(urlValue, await ensureHardHosts(), false);
}

export async function findBlockedHost(urlValue) {
  return findBlockedHostInList(urlValue, await ensureHosts());
}

export async function initializeHosts() {
  try { cachedHardHosts = await loadHosts(HARD_META_KEY, HARD_CHUNK_PREFIX); } catch {}
  try { cachedHosts = await loadHosts(); } catch {}
  browser.alarms.create(ALARM_NAME, { periodInMinutes: 60 });
  void updateHosts().catch(error => console.warn(`${LOG_PREFIX} Refresh failed; cached/bundled hosts remain active:`, error));
}

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) void updateHosts().catch(error => console.warn(`${LOG_PREFIX} Refresh failed:`, error));
});
