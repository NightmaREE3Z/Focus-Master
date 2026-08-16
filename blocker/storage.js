import { browser } from './api.js';
import {
  DATASET_PREFIX,
  DEFAULT_SETTINGS,
  MAX_CHUNK_BYTES,
  STORAGE_KEYS
} from './constants.js';
import { parseListText } from './csv.js';
import {
  normalizeLinkForStorage,
  normalizeRedirectUrl,
  normalizeTerm,
  normalizeTldForStorage,
  uniqueInOrder
} from './shared.js';
import { applyTrustedSiteEntries, normalizeTrustedSiteEntry } from './trusted-sites.js';

const DATASET_SCHEMA = 3;
const GITHUB_CONFIG_KEY = 'bfb:github-sync-config';
const VALID_PROFILES = new Set(['haukkis', 'tapsa']);
const REMOTE_BASE = 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/';

function normalizeProfileId(value) { return VALID_PROFILES.has(value) ? value : 'haukkis'; }
function termsFilename(profileId) { return normalizeProfileId(profileId) === 'tapsa' ? 'blockedTermsDad.csv' : 'blockedTerms.csv'; }

async function readConfiguredProfileId() {
  try {
    const result = await browser.storage.local.get(GITHUB_CONFIG_KEY);
    return normalizeProfileId(result[GITHUB_CONFIG_KEY]?.activeProfile);
  } catch { return 'haukkis'; }
}

export async function loadBundledFallbackLists(profileId = 'haukkis') {
  const termFile = termsFilename(profileId);
  const files = [
    [termFile, 'terms'],
    ['blockedLinks.csv', 'links'],
    ['blockedTLDs.csv', 'tlds'],
    ['TrustedSites.csv', 'trustedSites']
  ];
  const responses = await Promise.all(files.map(([filename]) =>
    fetch(browser.runtime.getURL(`blocker/lists/${filename}`), { cache: 'no-store' })
  ));
  if (responses.some(response => !response.ok)) throw new Error('Bundled BraveFox Focus Master lists could not be loaded.');
  const texts = await Promise.all(responses.map(response => response.text()));
  const output = { profile: normalizeProfileId(profileId) };
  files.forEach(([, kind], index) => { output[kind] = parseListText(texts[index], kind); });
  return output;
}

function filenameForKind(kind, profileId) {
  if (kind === 'terms') return termsFilename(profileId);
  if (kind === 'links') return 'blockedLinks.csv';
  if (kind === 'tlds') return 'blockedTLDs.csv';
  if (kind === 'trustedSites') return 'TrustedSites.csv';
  throw new Error('Unknown Focus Master list type.');
}

async function fetchRemoteList(kind, profileId) {
  const filename = filenameForKind(kind, profileId);
  const url = `${REMOTE_BASE}${filename}`;
  const response = await fetch(`${url}?bravefox_refresh=${Date.now()}`, {
    cache: 'no-store', credentials: 'omit', headers: { Accept: 'text/plain' }
  });
  if (!response.ok) throw new Error(`Remote Focus Master ${kind} list failed (HTTP ${response.status}).`);
  return parseListText(await response.text(), kind);
}

export async function loadRemoteFirstLists(profileId = null) {
  const profile = normalizeProfileId(profileId || await readConfiguredProfileId());
  const kinds = ['terms', 'links', 'tlds', 'trustedSites'];
  const results = await Promise.allSettled(kinds.map(kind => fetchRemoteList(kind, profile)));
  const output = { profile, usedBundledFallback: false };
  let bundled = null;
  for (let index = 0; index < kinds.length; index += 1) {
    const kind = kinds[index];
    if (results[index].status === 'fulfilled') output[kind] = results[index].value;
    else {
      bundled ||= await loadBundledFallbackLists(profile);
      output[kind] = bundled[kind];
      output.usedBundledFallback = true;
    }
  }
  return output;
}

const encoder = new TextEncoder();
let cachedDataset = null;
let datasetRepairPromise = null;
let settingsRepairPromise = null;

function bytes(value) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function chunkArray(values) {
  const chunks = [];
  let current = [];

  for (const value of values) {
    const candidate = [...current, value];
    if (current.length && bytes(candidate) > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = [value];
    } else {
      current = candidate;
    }
  }

  if (current.length || !chunks.length) chunks.push(current);
  return chunks;
}

function revisionKey(revision, kind, index) {
  return `${DATASET_PREFIX}${revision}:${kind}:${index}`;
}

function makeRevision() {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${Date.now().toString(36)}-${random[0].toString(36)}${random[1].toString(36)}`;
}

function normalizeDatasetSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const terms = uniqueInOrder(value.terms, normalizeTerm);
  const links = uniqueInOrder(value.links, normalizeLinkForStorage);
  const tlds = uniqueInOrder(value.tlds, normalizeTldForStorage);
  const trustedSites = uniqueInOrder(value.trustedSites, normalizeTrustedSiteEntry);
  const updatedAt = Number(value.updatedAt) || 0;
  const revision = String(value.revision || '');
  const profile = normalizeProfileId(value.profile);
  const schema = Math.max(2, Number(value.schema) || 2);
  if (!revision && !terms.length && !links.length && !tlds.length && !trustedSites.length && !updatedAt) return null;
  return {
    schema,
    terms,
    links,
    tlds,
    trustedSites,
    revision,
    profile,
    updatedAt,
    syncPending: Boolean(value.syncPending),
    syncError: String(value.syncError || '')
  };
}

async function readLocalDataset() {
  const result = await browser.storage.local.get(STORAGE_KEYS.localDataset);
  return normalizeDatasetSnapshot(result[STORAGE_KEYS.localDataset]);
}

async function writeLocalDataset(snapshot, patch = {}) {
  const normalized = normalizeDatasetSnapshot({ ...snapshot, ...patch });
  if (!normalized) return;
  await browser.storage.local.set({ [STORAGE_KEYS.localDataset]: normalized });
}

async function readSyncVersion(version) {
  if (!version?.revision) return null;
  const chunkCounts = {
    terms: Number(version.termChunks || 0),
    links: Number(version.linkChunks || 0),
    tlds: Number(version.tldChunks || 0),
    trustedSites: Number(version.trustedSiteChunks || 0)
  };
  const keys = [];
  for (const [kind, count] of Object.entries(chunkCounts)) {
    for (let i = 0; i < count; i += 1) keys.push(revisionKey(version.revision, kind, i));
  }

  const values = await browser.storage.sync.get(keys);
  const lists = { terms: [], links: [], tlds: [], trustedSites: [] };
  for (const [kind, count] of Object.entries(chunkCounts)) {
    for (let i = 0; i < count; i += 1) {
      const chunk = values[revisionKey(version.revision, kind, i)];
      if (!Array.isArray(chunk)) return null;
      lists[kind].push(...chunk);
    }
  }

  return normalizeDatasetSnapshot({
    schema: Number(version.schema) || 2,
    ...lists,
    revision: version.revision,
    profile: normalizeProfileId(version.profile),
    updatedAt: version.updatedAt || 0,
    syncPending: false,
    syncError: ''
  });
}

async function readSyncDataset() {
  const result = await browser.storage.sync.get(STORAGE_KEYS.datasetMeta);
  const meta = result[STORAGE_KEYS.datasetMeta] || { versions: [] };
  for (const version of Array.isArray(meta.versions) ? meta.versions : []) {
    const dataset = await readSyncVersion(version);
    if (dataset) return dataset;
  }
  return null;
}

async function writeSyncDataset(snapshot) {
  const clean = normalizeDatasetSnapshot(snapshot);
  if (!clean) throw new Error('Cannot sync an invalid dataset.');
  const chunks = {
    terms: chunkArray(clean.terms),
    links: chunkArray(clean.links),
    tlds: chunkArray(clean.tlds),
    trustedSites: chunkArray(clean.trustedSites)
  };
  const chunkPayload = {};
  for (const [kind, kindChunks] of Object.entries(chunks)) {
    kindChunks.forEach((chunk, index) => {
      chunkPayload[revisionKey(clean.revision, kind, index)] = chunk;
    });
  }

  await browser.storage.sync.set(chunkPayload);

  const oldResult = await browser.storage.sync.get(STORAGE_KEYS.datasetMeta);
  const oldMeta = oldResult[STORAGE_KEYS.datasetMeta] || { versions: [] };
  const currentVersion = {
    schema: DATASET_SCHEMA,
    revision: clean.revision,
    profile: clean.profile,
    termChunks: chunks.terms.length,
    linkChunks: chunks.links.length,
    tldChunks: chunks.tlds.length,
    trustedSiteChunks: chunks.trustedSites.length,
    termCount: clean.terms.length,
    linkCount: clean.links.length,
    tldCount: clean.tlds.length,
    trustedSiteCount: clean.trustedSites.length,
    updatedAt: clean.updatedAt
  };
  const previous = (Array.isArray(oldMeta.versions) ? oldMeta.versions : [])
    .filter(item => item?.revision && item.revision !== clean.revision)
    .slice(0, 1);
  const nextMeta = { schema: DATASET_SCHEMA, versions: [currentVersion, ...previous] };
  await browser.storage.sync.set({ [STORAGE_KEYS.datasetMeta]: nextMeta });

  // Verify that the browser accepted metadata and every current chunk.
  const verified = await readSyncVersion(currentVersion);
  if (!verified || verified.revision !== clean.revision ||
      verified.terms.length !== clean.terms.length ||
      verified.links.length !== clean.links.length ||
      verified.tlds.length !== clean.tlds.length ||
      verified.trustedSites.length !== clean.trustedSites.length) {
    throw new Error('Browser Sync verification failed after saving the Focus Master lists.');
  }

  const all = await browser.storage.sync.get(null);
  const keepRevisions = new Set(nextMeta.versions.map(item => item.revision));
  const staleKeys = Object.keys(all).filter(key => {
    if (!key.startsWith(DATASET_PREFIX)) return false;
    const revisionPart = key.slice(DATASET_PREFIX.length).split(':')[0];
    return revisionPart && !keepRevisions.has(revisionPart);
  });
  if (staleKeys.length) await browser.storage.sync.remove(staleKeys);
  return verified;
}

function chooseNewest(local, synced) {
  if (!local) return synced;
  if (!synced) return local;
  // Never let a profile-sync snapshot for Haukkis replace a local Tapsa list, or vice versa.
  if (local.profile !== synced.profile) return local;
  if (local.updatedAt > synced.updatedAt) return local;
  if (synced.updatedAt > local.updatedAt) return synced;
  if (local.revision === synced.revision) return local;
  return local;
}

function scheduleDatasetRepair(snapshot) {
  if (datasetRepairPromise || !snapshot) return;
  datasetRepairPromise = (async () => {
    try {
      await writeSyncDataset(snapshot);
      await writeLocalDataset(snapshot, { syncPending: false, syncError: '' });
      if (cachedDataset?.revision === snapshot.revision) {
        cachedDataset = { ...cachedDataset, syncPending: false, syncError: '' };
      }
    } catch (error) {
      await writeLocalDataset(snapshot, {
        syncPending: true,
        syncError: String(error?.message || error)
      });
    } finally {
      datasetRepairPromise = null;
    }
  })();
}

export async function loadDataset({ force = false } = {}) {
  if (!force && cachedDataset) return cachedDataset;

  const [local, synced, activeProfile] = await Promise.all([
    readLocalDataset(),
    readSyncDataset().catch(() => null),
    readConfiguredProfileId()
  ]);
  // A fresh install must not inherit the other person's terms merely because
  // browser profile-sync happened to contain a snapshot from that profile.
  const usableSynced = (!local && synced?.profile !== activeProfile) ? null : synced;
  let chosen = chooseNewest(local, usableSynced);
  if (!chosen) {
    try {
      const initial = await loadRemoteFirstLists(activeProfile);
      chosen = await saveDataset({
        terms: initial.terms, links: initial.links, tlds: initial.tlds,
        trustedSites: initial.trustedSites, profile: initial.profile
      });
      if (initial.usedBundledFallback) {
        console.warn('[BraveFox Focus Master] One or more remote lists failed; bundled fallback data was used.');
      }
    } catch (error) {
      console.warn('[BraveFox Focus Master] Remote and bundled initial list loading failed:', error);
      chosen = {
        schema: DATASET_SCHEMA, terms: [], links: [], tlds: [], trustedSites: [],
        revision: '', profile: activeProfile, updatedAt: 0, syncPending: false,
        syncError: String(error?.message || error)
      };
    }
  } else if (chosen.schema < DATASET_SCHEMA) {
    // One-time upgrade from the older two-list dataset. Preserve the user's
    // current Terms/Links exactly and seed only the two new global lists.
    try {
      const extended = await loadRemoteFirstLists(chosen.profile);
      chosen = await saveDataset({
        terms: chosen.terms, links: chosen.links, tlds: extended.tlds,
        trustedSites: extended.trustedSites, profile: chosen.profile
      });
    } catch (error) {
      console.warn('[BraveFox Focus Master] Extended-list migration failed; current lists remain active:', error);
    }
  }

  if (usableSynced && (!local || usableSynced.updatedAt > local.updatedAt || usableSynced.revision !== local.revision) && (!local || usableSynced.profile === local.profile)) {
    await writeLocalDataset(usableSynced, { syncPending: false, syncError: '' });
  } else if (local && (!usableSynced || local.updatedAt > usableSynced.updatedAt || local.syncPending)) {
    scheduleDatasetRepair(local);
  }

  cachedDataset = chosen;
  applyTrustedSiteEntries(chosen.trustedSites, { source: 'dataset', lastUpdated: chosen.updatedAt });
  return cachedDataset;
}

export async function saveDataset({ terms, links, tlds, trustedSites, profile = '' }) {
  const existing = await readLocalDataset();
  const snapshotProfile = normalizeProfileId(profile || existing?.profile || await readConfiguredProfileId());
  const snapshot = {
    schema: DATASET_SCHEMA,
    terms: uniqueInOrder(terms ?? existing?.terms ?? [], normalizeTerm),
    links: uniqueInOrder(links ?? existing?.links ?? [], normalizeLinkForStorage),
    tlds: uniqueInOrder(tlds ?? existing?.tlds ?? [], normalizeTldForStorage),
    trustedSites: uniqueInOrder(trustedSites ?? existing?.trustedSites ?? [], normalizeTrustedSiteEntry),
    profile: snapshotProfile,
    revision: makeRevision(),
    updatedAt: Date.now(),
    syncPending: true,
    syncError: ''
  };

  // Local mirror is committed first. A Chrome restart can therefore never
  // erase a successful import merely because profile sync was delayed or failed.
  await writeLocalDataset(snapshot);
  cachedDataset = snapshot;
  applyTrustedSiteEntries(snapshot.trustedSites, { source: 'dataset', lastUpdated: snapshot.updatedAt });
  let result = snapshot;

  try {
    await writeSyncDataset(snapshot);
    result = { ...snapshot, syncPending: false, syncError: '' };
    cachedDataset = result;
    await writeLocalDataset(result);
    applyTrustedSiteEntries(result.trustedSites, { source: 'dataset', lastUpdated: result.updatedAt });
  } catch (error) {
    result = {
      ...snapshot,
      syncPending: true,
      syncError: String(error?.message || error)
    };
    cachedDataset = result;
    await writeLocalDataset(result);
    scheduleDatasetRepair(result);
  }

  // Return the immutable result of this save, not the shared cache reference.
  // A storage.onChanged reconciliation can update the cache concurrently.
  return result;
}

function normalizeSettingsRecord(value, fallbackUpdatedAt = 0) {
  if (!value || typeof value !== 'object') return null;
  const wrapped = value.value && typeof value.value === 'object'
    ? value
    : { value, updatedAt: fallbackUpdatedAt };
  const source = wrapped.value || {};
  const legacyRedirectUrl = normalizeRedirectUrl(source.redirectUrl);
  const redirectTermsUrl = normalizeRedirectUrl(source.redirectTermsUrl || legacyRedirectUrl);
  const redirectLinksUrl = normalizeRedirectUrl(source.redirectLinksUrl);
  return {
    value: {
      ...DEFAULT_SETTINGS,
      enabled: Boolean(source.enabled ?? DEFAULT_SETTINGS.enabled),
      blockTerms: Boolean(source.blockTerms ?? DEFAULT_SETTINGS.blockTerms),
      blockLinks: Boolean(source.blockLinks ?? DEFAULT_SETTINGS.blockLinks),
      lockManager: true,
      unlockTtlMinutes: Math.min(60, Math.max(1, Number(source.unlockTtlMinutes) || DEFAULT_SETTINGS.unlockTtlMinutes)),
      redirectTerms: Boolean(source.redirectTerms) && Boolean(redirectTermsUrl),
      redirectTermsUrl,
      redirectLinks: Boolean(source.redirectLinks) && Boolean(redirectLinksUrl),
      redirectLinksUrl
    },
    updatedAt: Number(wrapped.updatedAt) || 0,
    syncPending: Boolean(wrapped.syncPending),
    syncError: String(wrapped.syncError || '')
  };
}

async function writeSettingsLocal(record) {
  await browser.storage.local.set({ [STORAGE_KEYS.localSettings]: record });
}

function scheduleSettingsRepair(record) {
  if (settingsRepairPromise || !record) return;
  settingsRepairPromise = (async () => {
    try {
      const clean = { value: record.value, updatedAt: record.updatedAt };
      await browser.storage.sync.set({ [STORAGE_KEYS.settings]: clean });
      await writeSettingsLocal({ ...clean, syncPending: false, syncError: '' });
    } catch (error) {
      await writeSettingsLocal({
        ...record,
        syncPending: true,
        syncError: String(error?.message || error)
      });
    } finally {
      settingsRepairPromise = null;
    }
  })();
}

export async function getSettings() {
  const [localResult, syncResult] = await Promise.all([
    browser.storage.local.get(STORAGE_KEYS.localSettings),
    browser.storage.sync.get(STORAGE_KEYS.settings).catch(() => ({}))
  ]);
  const local = normalizeSettingsRecord(localResult[STORAGE_KEYS.localSettings]);
  const synced = normalizeSettingsRecord(syncResult[STORAGE_KEYS.settings]);
  let chosen = local || synced || normalizeSettingsRecord(DEFAULT_SETTINGS);

  if (local && synced && synced.updatedAt > local.updatedAt) chosen = synced;
  if (synced && (!local || synced.updatedAt > local.updatedAt)) {
    await writeSettingsLocal({ ...synced, syncPending: false, syncError: '' });
  } else if (local && (!synced || local.updatedAt > synced.updatedAt || local.syncPending)) {
    scheduleSettingsRepair(local);
  }
  return chosen.value;
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  next.enabled = Boolean(next.enabled);
  next.blockTerms = Boolean(next.blockTerms);
  next.blockLinks = Boolean(next.blockLinks);
  next.lockManager = true;
  next.unlockTtlMinutes = Math.min(60, Math.max(1, Number(next.unlockTtlMinutes) || DEFAULT_SETTINGS.unlockTtlMinutes));
  next.redirectTermsUrl = normalizeRedirectUrl(next.redirectTermsUrl || next.redirectUrl);
  next.redirectLinksUrl = normalizeRedirectUrl(next.redirectLinksUrl);
  next.redirectTerms = Boolean(next.redirectTerms) && Boolean(next.redirectTermsUrl);
  next.redirectLinks = Boolean(next.redirectLinks) && Boolean(next.redirectLinksUrl);
  delete next.redirectUrl;

  const record = { value: next, updatedAt: Date.now(), syncPending: true, syncError: '' };
  await writeSettingsLocal(record);
  try {
    const clean = { value: next, updatedAt: record.updatedAt };
    await browser.storage.sync.set({ [STORAGE_KEYS.settings]: clean });
    await writeSettingsLocal({ ...clean, syncPending: false, syncError: '' });
  } catch (error) {
    const pending = { ...record, syncError: String(error?.message || error) };
    await writeSettingsLocal(pending);
    scheduleSettingsRepair(pending);
  }
  return next;
}

export async function synchronizeNow() {
  // Let any queued repair finish first so the manual run does not race it.
  if (datasetRepairPromise) {
    try { await datasetRepairPromise; } catch {}
  }
  if (settingsRepairPromise) {
    try { await settingsRepairPromise; } catch {}
  }

  const currentDataset = await loadDataset({ force: true });
  let dataset = currentDataset;

  // A completely fresh installation has no revision yet. Creating one allows
  // the empty lists to be synchronized too, which is useful after a restore or
  // deliberate list wipe.
  if (!currentDataset.revision) {
    dataset = await saveDataset({
      terms: currentDataset.terms,
      links: currentDataset.links,
      tlds: currentDataset.tlds,
      trustedSites: currentDataset.trustedSites,
      profile: currentDataset.profile
    });
  } else {
    try {
      const verified = await writeSyncDataset(currentDataset);
      dataset = {
        ...verified,
        syncPending: false,
        syncError: ''
      };
      cachedDataset = dataset;
      await writeLocalDataset(dataset);
      applyTrustedSiteEntries(dataset.trustedSites, { source: 'dataset', lastUpdated: dataset.updatedAt });
    } catch (error) {
      dataset = {
        ...currentDataset,
        syncPending: true,
        syncError: String(error?.message || error)
      };
      cachedDataset = dataset;
      await writeLocalDataset(dataset);
      scheduleDatasetRepair(dataset);
    }
  }

  // getSettings() first reconciles local and remote timestamps. Re-saving the
  // chosen settings forces an immediate profile-sync write and refreshes the
  // local persistent mirror.
  const settings = await updateSettings(await getSettings());
  return { dataset, settings };
}

export function invalidateDatasetCache() {
  cachedDataset = null;
}
