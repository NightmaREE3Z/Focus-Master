import { browser } from './api.js';
import { isCompletelyExcludedUrl } from './shared.js';

const LOG_PREFIX = '[BraveFox Focus Master Hosts]';
const SOURCE_META_PREFIX = 'bfb:hosts-source-meta:v2:';
const SOURCE_CHUNK_PREFIX = 'bfb:hosts-source-chunk:v2:';
const ALARM_NAME = 'bfb-hosts-refresh';
const CHUNK_SIZE = 5000;
const REMOTE_TIMEOUT_MS = 4500;
const REMOTE_RETRIES_WITH_FALLBACK = 1;
const REMOTE_RETRIES_NO_FALLBACK = 2;
const REMOTE_RETRY_DELAY_MS = 750;

// BraveFoxHosts + legacyFox form the remotely maintainable hard-host shield.
// Their bundled copies are cold-start/offline fallbacks. StevenBlack remains a
// normal supplemental layer so Trusted Sites and scoped path rules can outrank it.
const SOURCES = [
  {
    id: 'BraveFoxHosts',
    tier: 'hard',
    url: 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/BraveFoxHosts',
    fallbackPath: 'blocker/lists/BraveFoxHosts'
  },
  {
    id: 'StevenBlack',
    tier: 'supplemental',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-porn/hosts'
  },
  {
    id: 'legacyFox',
    tier: 'hard',
    url: 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/legacyFox',
    fallbackPath: 'blocker/lists/legacyFox'
  }
];

let cachedHardHosts = null;
let cachedSupplementalHosts = null;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url, timeoutMs = REMOTE_TIMEOUT_MS) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
  try {
    const response = await fetch(url, {
      signal: controller?.signal,
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'text/plain' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function sourceMetaKey(source) {
  return `${SOURCE_META_PREFIX}${source.id}`;
}

function sourceChunkPrefix(source) {
  return `${SOURCE_CHUNK_PREFIX}${source.id}:`;
}

function sourceChunkKey(source, index) {
  return `${sourceChunkPrefix(source)}${index}`;
}

async function saveSourceHosts(source, hosts, origin) {
  const normalized = [...new Set((Array.isArray(hosts) ? hosts : []).map(normalizeHost).filter(Boolean))].sort();
  const allStorage = await browser.storage.local.get(null);
  const prefix = sourceChunkPrefix(source);
  const oldKeys = Object.keys(allStorage).filter(key => key.startsWith(prefix));
  const payload = {};
  let chunks = 0;

  for (let index = 0; index < normalized.length; index += CHUNK_SIZE) {
    payload[sourceChunkKey(source, chunks)] = normalized.slice(index, index + CHUNK_SIZE);
    chunks += 1;
  }

  payload[sourceMetaKey(source)] = {
    schema: 2,
    tier: source.tier,
    chunks,
    count: normalized.length,
    updatedAt: Date.now(),
    origin: String(origin || 'unknown')
  };

  await browser.storage.local.set(payload);
  const keep = new Set(Object.keys(payload));
  const stale = oldKeys.filter(key => !keep.has(key));
  if (stale.length) await browser.storage.local.remove(stale);
  return normalized;
}

async function loadSourceHosts(source) {
  const meta = (await browser.storage.local.get(sourceMetaKey(source)))[sourceMetaKey(source)];
  if (!meta || Number(meta.chunks) <= 0) return [];
  const keys = Array.from({ length: Number(meta.chunks) }, (_, index) => sourceChunkKey(source, index));
  const data = await browser.storage.local.get(keys);
  const hosts = [];
  for (const key of keys) {
    if (Array.isArray(data[key])) hosts.push(...data[key]);
  }
  return [...new Set(hosts.map(normalizeHost).filter(Boolean))].sort();
}

async function loadBundledSource(source) {
  if (!source.fallbackPath) return [];
  try {
    return [...new Set(parseHostsText(await fetchText(browser.runtime.getURL(source.fallbackPath), 0)))].sort();
  } catch (error) {
    console.warn(`${LOG_PREFIX} ${source.id} bundled fallback failed:`, error);
    return [];
  }
}

async function fetchRemoteSource(source) {
  const attempts = source.fallbackPath ? REMOTE_RETRIES_WITH_FALLBACK : REMOTE_RETRIES_NO_FALLBACK;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const text = await fetchText(`${source.url}?bravefox_refresh=${Date.now()}`);
      const hosts = [...new Set(parseHostsText(text))].sort();
      if (!hosts.length) throw new Error('Remote list contained no usable hosts.');
      return hosts;
    } catch (error) {
      lastError = error;
      console.warn(`${LOG_PREFIX} ${source.id} remote attempt ${attempt}/${attempts} failed:`, error);
      if (attempt < attempts) await sleep(REMOTE_RETRY_DELAY_MS);
    }
  }

  throw lastError || new Error(`${source.id} remote source unavailable.`);
}

async function resolveSource(source) {
  try {
    const hosts = await fetchRemoteSource(source);
    await saveSourceHosts(source, hosts, 'remote');
    return { hosts, origin: 'remote' };
  } catch (remoteError) {
    const cached = await loadSourceHosts(source).catch(() => []);
    if (cached.length) {
      console.warn(`${LOG_PREFIX} ${source.id}: remote unavailable, using last-known-good cache.`);
      return { hosts: cached, origin: 'cache' };
    }

    const bundled = await loadBundledSource(source);
    if (bundled.length) {
      console.warn(`${LOG_PREFIX} ${source.id}: no cache available, using bundled fallback.`);
      await saveSourceHosts(source, bundled, 'bundled-fallback').catch(() => {});
      return { hosts: bundled, origin: 'bundled-fallback' };
    }

    console.warn(`${LOG_PREFIX} ${source.id} unavailable and has no usable cache/fallback:`, remoteError);
    return { hosts: [], origin: 'unavailable' };
  }
}

function buildTierHosts(sourceResults, tier) {
  const seen = new Set();
  for (const { source, hosts } of sourceResults) {
    if (source.tier !== tier) continue;
    for (const host of hosts) {
      const normalized = normalizeHost(host);
      if (normalized) seen.add(normalized);
    }
  }
  return [...seen].sort();
}

async function loadImmediateTierCaches() {
  const sourceResults = [];
  for (const source of SOURCES) {
    let hosts = await loadSourceHosts(source).catch(() => []);
    let origin = hosts.length ? 'cache' : 'unavailable';

    if (!hosts.length && source.fallbackPath) {
      hosts = await loadBundledSource(source);
      if (hosts.length) {
        origin = 'bundled-fallback';
        await saveSourceHosts(source, hosts, origin).catch(() => {});
      }
    }

    sourceResults.push({ source, hosts, origin });
  }

  cachedHardHosts = buildTierHosts(sourceResults, 'hard');
  cachedSupplementalHosts = buildTierHosts(sourceResults, 'supplemental');
  return sourceResults;
}

export async function updateHosts() {
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    const sourceResults = [];
    for (const source of SOURCES) {
      const result = await resolveSource(source);
      sourceResults.push({ source, ...result });
    }

    cachedHardHosts = buildTierHosts(sourceResults, 'hard');
    cachedSupplementalHosts = buildTierHosts(sourceResults, 'supplemental');

    if (!cachedHardHosts.length && !cachedSupplementalHosts.length) {
      throw new Error('No hosts source, cache or bundled fallback could be loaded.');
    }

    return {
      hard: cachedHardHosts,
      supplemental: cachedSupplementalHosts
    };
  })().finally(() => { updatePromise = null; });
  return updatePromise;
}

async function ensureHosts() {
  if (!cachedHardHosts || !cachedSupplementalHosts) await loadImmediateTierCaches();
  return {
    hard: cachedHardHosts || [],
    supplemental: cachedSupplementalHosts || []
  };
}

function binaryHas(sorted, value) {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const current = sorted[mid];
    if (current === value) return true;
    if (current < value) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}

function findHostInSorted(host, hosts) {
  const labels = host.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join('.');
    if (binaryHas(hosts, candidate)) return candidate;
  }
  return '';
}

async function parseCandidateHost(urlValue) {
  try {
    return normalizeHost(new URL(String(urlValue || '')).hostname);
  } catch {
    return '';
  }
}

// Hard-host feeds deliberately ignore TrustedSites.csv. This is the remotely
// maintainable shield tier and sits beside the compiled HARD_CODED_LINKS floor.
export async function findHardBlockedHost(urlValue) {
  const host = await parseCandidateHost(urlValue);
  if (!host) return '';
  const { hard } = await ensureHosts();
  return findHostInSorted(host, hard);
}

// Supplemental hosts remain a normal blocker layer. Trusted Sites can bypass
// these entries, and callers may also suppress them for scoped path/query rules.
export async function findBlockedHost(urlValue) {
  if (isCompletelyExcludedUrl(urlValue)) return '';
  const host = await parseCandidateHost(urlValue);
  if (!host) return '';
  const { supplemental } = await ensureHosts();
  return findHostInSorted(host, supplemental);
}

export async function getHostsStatus() {
  const { hard, supplemental } = await ensureHosts();
  const sourceStats = {};
  let lastUpdated = 0;

  for (const source of SOURCES) {
    try {
      const meta = (await browser.storage.local.get(sourceMetaKey(source)))[sourceMetaKey(source)] || null;
      if (!meta) continue;
      sourceStats[source.id] = {
        tier: source.tier,
        origin: String(meta.origin || 'unknown'),
        count: Number(meta.count || 0),
        updatedAt: Number(meta.updatedAt || 0)
      };
      lastUpdated = Math.max(lastUpdated, Number(meta.updatedAt || 0));
    } catch {}
  }

  return {
    count: hard.length + supplemental.length,
    hardCount: hard.length,
    supplementalCount: supplemental.length,
    lastUpdated,
    sourceStats
  };
}

export async function initializeHosts() {
  try {
    const initial = await loadImmediateTierCaches();
    const hardCount = cachedHardHosts?.length || 0;
    const supplementalCount = cachedSupplementalHosts?.length || 0;
    if (hardCount || supplementalCount) {
      const origins = initial.map(entry => `${entry.source.id}:${entry.origin}`).join(', ');
      console.log(`${LOG_PREFIX} Immediate hosts ready: ${hardCount} hard + ${supplementalCount} supplemental (${origins}).`);
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} Immediate cache/fallback load failed:`, error);
  }

  browser.alarms.create(ALARM_NAME, { periodInMinutes: 60 });
  void updateHosts().catch(error => console.warn(`${LOG_PREFIX} Refresh failed; cached/bundled hosts remain active:`, error));
}

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    void updateHosts().catch(error => console.warn(`${LOG_PREFIX} Refresh failed:`, error));
  }
});
