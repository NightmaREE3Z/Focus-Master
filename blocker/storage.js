import {
  DATASET_PREFIX,
  DEFAULT_SETTINGS,
  MAX_CHUNK_BYTES,
  STORAGE_KEYS
} from './constants.js';
import {
  normalizeLinkForStorage,
  normalizeRedirectUrl,
  normalizeTerm,
  uniqueInOrder
} from './shared.js';

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
  const updatedAt = Number(value.updatedAt) || 0;
  const revision = String(value.revision || '');
  if (!revision && !terms.length && !links.length && !updatedAt) return null;
  return {
    terms,
    links,
    revision,
    updatedAt,
    syncPending: Boolean(value.syncPending),
    syncError: String(value.syncError || '')
  };
}

async function readLocalDataset() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.localDataset);
  return normalizeDatasetSnapshot(result[STORAGE_KEYS.localDataset]);
}

async function writeLocalDataset(snapshot, patch = {}) {
  const normalized = normalizeDatasetSnapshot({ ...snapshot, ...patch });
  if (!normalized) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.localDataset]: normalized });
}

async function readSyncVersion(version) {
  if (!version?.revision) return null;
  const keys = [];
  for (let i = 0; i < Number(version.termChunks || 0); i += 1) keys.push(revisionKey(version.revision, 'terms', i));
  for (let i = 0; i < Number(version.linkChunks || 0); i += 1) keys.push(revisionKey(version.revision, 'links', i));

  const values = await chrome.storage.sync.get(keys);
  const terms = [];
  const links = [];

  for (let i = 0; i < Number(version.termChunks || 0); i += 1) {
    const chunk = values[revisionKey(version.revision, 'terms', i)];
    if (!Array.isArray(chunk)) return null;
    terms.push(...chunk);
  }
  for (let i = 0; i < Number(version.linkChunks || 0); i += 1) {
    const chunk = values[revisionKey(version.revision, 'links', i)];
    if (!Array.isArray(chunk)) return null;
    links.push(...chunk);
  }

  return normalizeDatasetSnapshot({
    terms,
    links,
    revision: version.revision,
    updatedAt: version.updatedAt || 0,
    syncPending: false,
    syncError: ''
  });
}

async function readSyncDataset() {
  const result = await chrome.storage.sync.get(STORAGE_KEYS.datasetMeta);
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
  const termChunks = chunkArray(clean.terms);
  const linkChunks = chunkArray(clean.links);
  const chunkPayload = {};

  termChunks.forEach((chunk, index) => {
    chunkPayload[revisionKey(clean.revision, 'terms', index)] = chunk;
  });
  linkChunks.forEach((chunk, index) => {
    chunkPayload[revisionKey(clean.revision, 'links', index)] = chunk;
  });

  await chrome.storage.sync.set(chunkPayload);

  const oldResult = await chrome.storage.sync.get(STORAGE_KEYS.datasetMeta);
  const oldMeta = oldResult[STORAGE_KEYS.datasetMeta] || { versions: [] };
  const currentVersion = {
    revision: clean.revision,
    termChunks: termChunks.length,
    linkChunks: linkChunks.length,
    termCount: clean.terms.length,
    linkCount: clean.links.length,
    updatedAt: clean.updatedAt
  };
  const previous = (Array.isArray(oldMeta.versions) ? oldMeta.versions : [])
    .filter(item => item?.revision && item.revision !== clean.revision)
    .slice(0, 1);
  const nextMeta = { schema: 2, versions: [currentVersion, ...previous] };
  await chrome.storage.sync.set({ [STORAGE_KEYS.datasetMeta]: nextMeta });

  // Verify that Chrome accepted the metadata and every current chunk.
  const verified = await readSyncVersion(currentVersion);
  if (!verified || verified.revision !== clean.revision ||
      verified.terms.length !== clean.terms.length || verified.links.length !== clean.links.length) {
    throw new Error('Chrome Sync verification failed after saving the blocklists.');
  }

  const all = await chrome.storage.sync.get(null);
  const keepRevisions = new Set(nextMeta.versions.map(item => item.revision));
  const staleKeys = Object.keys(all).filter(key => {
    if (!key.startsWith(DATASET_PREFIX)) return false;
    const revisionPart = key.slice(DATASET_PREFIX.length).split(':')[0];
    return revisionPart && !keepRevisions.has(revisionPart);
  });
  if (staleKeys.length) await chrome.storage.sync.remove(staleKeys);
  return verified;
}

function chooseNewest(local, synced) {
  if (!local) return synced;
  if (!synced) return local;
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

  const [local, synced] = await Promise.all([
    readLocalDataset(),
    readSyncDataset().catch(() => null)
  ]);
  const chosen = chooseNewest(local, synced) || {
    terms: [],
    links: [],
    revision: '',
    updatedAt: 0,
    syncPending: false,
    syncError: ''
  };

  if (synced && (!local || synced.updatedAt > local.updatedAt || synced.revision !== local.revision)) {
    await writeLocalDataset(synced, { syncPending: false, syncError: '' });
  } else if (local && (!synced || local.updatedAt > synced.updatedAt || local.syncPending)) {
    scheduleDatasetRepair(local);
  }

  cachedDataset = chosen;
  return cachedDataset;
}

export async function saveDataset({ terms, links }) {
  const snapshot = {
    terms: uniqueInOrder(terms, normalizeTerm),
    links: uniqueInOrder(links, normalizeLinkForStorage),
    revision: makeRevision(),
    updatedAt: Date.now(),
    syncPending: true,
    syncError: ''
  };

  // Local mirror is committed first. A Chrome restart can therefore never
  // erase a successful import merely because profile sync was delayed or failed.
  await writeLocalDataset(snapshot);
  cachedDataset = snapshot;
  let result = snapshot;

  try {
    await writeSyncDataset(snapshot);
    result = { ...snapshot, syncPending: false, syncError: '' };
    cachedDataset = result;
    await writeLocalDataset(result);
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
  await chrome.storage.local.set({ [STORAGE_KEYS.localSettings]: record });
}

function scheduleSettingsRepair(record) {
  if (settingsRepairPromise || !record) return;
  settingsRepairPromise = (async () => {
    try {
      const clean = { value: record.value, updatedAt: record.updatedAt };
      await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: clean });
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
    chrome.storage.local.get(STORAGE_KEYS.localSettings),
    chrome.storage.sync.get(STORAGE_KEYS.settings).catch(() => ({}))
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
    await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: clean });
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
      links: currentDataset.links
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
