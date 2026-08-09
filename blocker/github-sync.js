import { parseListText, serializeListCsv } from './csv.js';
import { loadBundledFallbackLists, loadDataset, saveDataset } from './storage.js';
import { normalizeLinkForStorage, normalizeTerm, uniqueInOrder } from './shared.js';
import { getTrustedSitesStatus, initializeTrustedSites, refreshTrustedSites } from './trusted-sites.js';

const browser = globalThis.browser ?? globalThis.chrome;
const INCOGNITO_CONTEXT = Boolean(browser.extension?.inIncognitoContext);
const LOG_PREFIX = '[BraveFox Focus Master GitHub Sync]';
const CONFIG_KEY = 'bfb:github-sync-config';
const TOKEN_VAULT_KEY = 'bfb:github-token-vault-v1';
const TOKEN_VAULT_VERSION = 1;
const TOKEN_RECOVERY_VERSION = 2;
const TOKEN_RECOVERY_META_KEY = 'bfb:github-token-drive-recovery-meta-v1';
const TOKEN_RECOVERY_FILE_NAME = 'focus-master-pat-recovery.json';
const TOKEN_RECOVERY_APP_ID = 'focus-master-standalone';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const STATE_KEY = 'bfb:github-sync-state';
const AUTO_SYNC_ALARM = 'bfb-github-auto-sync';
const DEBOUNCED_SYNC_ALARM = 'bfb-github-debounced-sync';
const PAT_RECOVERY_RETRY_ALARM = 'bfb-pat-recovery-retry';
const AUTO_SYNC_INTERVAL_MINUTES = 15;
const DEBOUNCE_MS = 5000;
const REQUIRED_DATA_COLLECTION = Object.freeze(['authenticationInfo', 'browsingActivity', 'searchTerms']);

export const SYNC_PROFILES = Object.freeze({
  haukkis: Object.freeze({
    id: 'haukkis', label: 'Haukkis', termsFile: 'blockedTerms.csv',
    emails: Object.freeze(['xanaronnosucks@gmail.com', 'ripxanaronnov6@gmail.com', 'xanaronnosucksvm@gmail.com'])
  }),
  tapsa: Object.freeze({
    id: 'tapsa', label: 'Tapsa', termsFile: 'blockedTermsDad.csv',
    emails: Object.freeze(['tapsa.hauki@gmail.com'])
  })
});

const PAT_RECOVERY_ALLOWED_EMAILS = Object.freeze([
  'tapsa.hauki@gmail.com',
  'xanaronnosucks@gmail.com',
  'ripxanaronnov6@gmail.com',
  'xanaronnosucksvm@gmail.com'
]);

export const GITHUB_SYNC_TARGET = Object.freeze({
  owner: 'NightmaREE3Z', repository: 'Focus-Master', branch: 'BraveFox',
  files: Object.freeze({
    links: Object.freeze({ path: 'blocker/lists/blockedLinks.csv', rawUrl: 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/blockedLinks.csv' }),
    trustedSites: Object.freeze({ path: 'blocker/lists/TrustedSites.csv', rawUrl: 'https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/blocker/lists/TrustedSites.csv' })
  })
});

const DEFAULT_CONFIG = Object.freeze({
  autoSync: true, token: '', tokenRecovery: true, activeProfile: 'haukkis', profileExplicit: false,
  profileSwitchPending: false, previousProfile: '', detectedEmail: '',
  suggestedProfile: '', detectionAvailable: false
});
const DEFAULT_STATE = Object.freeze({
  termsProfile: 'haukkis', initializedProfiles: { haukkis: false, tapsa: false },
  initializedLinks: false, pending: [],
  forceSnapshot: { links: false, terms: { haukkis: false, tapsa: false } },
  lastSyncAt: 0, lastAction: '', lastError: ''
});
let syncPromise = null;

function normalizeProfile(value) { return Object.hasOwn(SYNC_PROFILES, value) ? value : 'haukkis'; }
function profileForEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  for (const profile of Object.values(SYNC_PROFILES)) if (profile.emails.includes(normalized)) return profile.id;
  return '';
}
function normalizerFor(kind) { return kind === 'links' ? normalizeLinkForStorage : normalizeTerm; }
function normalizeKind(kind) { if (kind === 'terms' || kind === 'links') return kind; throw new Error('Unknown GitHub blocklist type.'); }
function termsTarget(profileId) {
  const profile = SYNC_PROFILES[normalizeProfile(profileId)];
  const path = `blocker/lists/${profile.termsFile}`;
  return { path, rawUrl: `https://raw.githubusercontent.com/NightmaREE3Z/Focus-Master/refs/heads/BraveFox/${path}` };
}
function fileFor(kind, profileId) { return kind === 'terms' ? termsTarget(profileId) : GITHUB_SYNC_TARGET.files.links; }

function normalizeConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    autoSync: source.autoSync !== false,
    token: String(source.token || '').trim(),
    tokenRecovery: source.tokenRecovery !== false,
    activeProfile: normalizeProfile(source.activeProfile),
    profileExplicit: Boolean(source.profileExplicit),
    profileSwitchPending: Boolean(source.profileSwitchPending),
    previousProfile: Object.hasOwn(SYNC_PROFILES, source.previousProfile) ? source.previousProfile : '',
    detectedEmail: String(source.detectedEmail || '').trim().toLowerCase(),
    suggestedProfile: Object.hasOwn(SYNC_PROFILES, source.suggestedProfile) ? source.suggestedProfile : '',
    detectionAvailable: Boolean(source.detectionAvailable)
  };
}

function normalizeState(value, activeProfile = 'haukkis') {
  const source = value && typeof value === 'object' ? value : {};
  const termsProfile = normalizeProfile(source.termsProfile || activeProfile);
  const pending = [];
  for (const item of Array.isArray(source.pending) ? source.pending : []) {
    if (!item || (item.kind !== 'terms' && item.kind !== 'links')) continue;
    if (item.action !== 'add' && item.action !== 'remove') continue;
    const normalized = normalizerFor(item.kind)(item.value);
    if (!normalized) continue;
    pending.push({
      id: String(item.id || `${Date.now()}-${Math.random()}`), kind: item.kind,
      profile: item.kind === 'terms' ? normalizeProfile(item.profile || termsProfile) : 'global',
      action: item.action, value: normalized, createdAt: Number(item.createdAt) || Date.now()
    });
  }
  const initializedProfiles = {
    haukkis: Boolean(source.initializedProfiles?.haukkis),
    tapsa: Boolean(source.initializedProfiles?.tapsa)
  };
  if (source.initialized === true) initializedProfiles[termsProfile] = true;
  return {
    termsProfile,
    initializedProfiles,
    initializedLinks: Boolean(source.initializedLinks ?? source.initialized),
    pending,
    forceSnapshot: {
      links: Boolean(source.forceSnapshot?.links),
      terms: {
        haukkis: Boolean(source.forceSnapshot?.terms?.haukkis ?? (source.forceSnapshot?.terms === true && termsProfile === 'haukkis')),
        tapsa: Boolean(source.forceSnapshot?.terms?.tapsa ?? (source.forceSnapshot?.terms === true && termsProfile === 'tapsa'))
      }
    },
    lastSyncAt: Number(source.lastSyncAt) || 0,
    lastAction: String(source.lastAction || ''),
    lastError: String(source.lastError || '')
  };
}

function normalizeToken(value) { return String(value || '').trim(); }
function tokenVaultRecord(token) {
  return {
    version: TOKEN_VAULT_VERSION,
    token: normalizeToken(token),
    updatedAt: Date.now()
  };
}
function tokenRecoveryRecord(token, accountEmail = '') {
  return {
    version: TOKEN_RECOVERY_VERSION,
    application: TOKEN_RECOVERY_APP_ID,
    extensionId: String(browser.runtime?.id || ''),
    accountEmail: String(accountEmail || '').trim().toLowerCase(),
    token: normalizeToken(token),
    updatedAt: Date.now()
  };
}
function patRecoveryAccess(detected = {}) {
  const email = String(detected.email || '').trim().toLowerCase();
  const detectionAvailable = Boolean(detected.available);
  const allowed = detectionAvailable && Boolean(email) && PAT_RECOVERY_ALLOWED_EMAILS.includes(email);
  let blockedReason = '';
  if (!detectionAvailable) blockedReason = 'Chrome profile account detection is unavailable.';
  else if (!email) blockedReason = 'No Chrome profile account is signed in.';
  else if (!allowed) blockedReason = `The Chrome profile account ${email} is not approved for automatic PAT recovery.`;
  return { detectionAvailable, email, allowed, blockedReason };
}
async function currentPatRecoveryAccess() {
  return patRecoveryAccess(await detectBrowserProfileEmail());
}
function runtimeErrorMessage() {
  try { return String(browser.runtime?.lastError?.message || ''); } catch { return ''; }
}
function normalizeAuthTokenResult(value) {
  if (typeof value === 'string') return value.trim();
  return String(value?.token || '').trim();
}
async function getGoogleAuthToken({ interactive = false } = {}) {
  if (INCOGNITO_CONTEXT) {
    return { supported: false, authorized: false, token: '', interactionRequired: false, error: 'Google identity is disabled in Incognito.' };
  }
  const identity = browser.identity;
  if (!identity?.getAuthToken) {
    return { supported: false, authorized: false, token: '', interactionRequired: false, error: 'Chrome OAuth is unavailable.' };
  }
  return new Promise(resolve => {
    let settled = false;
    let timeoutId = 0;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      const token = normalizeAuthTokenResult(value);
      const runtimeError = runtimeErrorMessage();
      resolve({
        supported: true,
        authorized: Boolean(token),
        token,
        interactionRequired: !token,
        error: token ? '' : (runtimeError || (interactive ? 'Google Drive authorization was not completed.' : 'Google Drive authorization is required.'))
      });
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ supported: true, authorized: false, token: '', interactionRequired: true, error: String(error?.message || error || 'Google Drive authorization failed.') });
    };
    try {
      const maybe = identity.getAuthToken({ interactive: Boolean(interactive) }, finish);
      if (maybe?.then) maybe.then(finish).catch(fail);
    } catch (error) { fail(error); }
    if (!settled) timeoutId = setTimeout(() => finish(null), interactive ? 120000 : 8000);
  });
}
async function removeCachedGoogleAuthToken(token) {
  if (INCOGNITO_CONTEXT || !token || !browser.identity?.removeCachedAuthToken) return;
  await new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const maybe = browser.identity.removeCachedAuthToken({ token }, done);
      if (maybe?.then) maybe.then(done).catch(done);
    } catch { done(); }
    setTimeout(done, 1500);
  });
}
async function responseError(response, label) {
  let detail = '';
  try {
    const text = await response.text();
    if (text) {
      try { detail = String(JSON.parse(text)?.error?.message || text); }
      catch { detail = text; }
    }
  } catch {}
  return `${label} failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`;
}
async function driveRequest(url, options = {}, { interactive = false, retryAuth = true } = {}) {
  const auth = await getGoogleAuthToken({ interactive });
  if (!auth.token) return { ok: false, response: null, auth, error: auth.error };
  let response;
  try {
    response = await fetch(url, {
      ...options,
      cache: 'no-store',
      credentials: 'omit',
      headers: { ...(options.headers || {}), Authorization: `Bearer ${auth.token}` }
    });
  } catch (error) {
    return { ok: false, response: null, auth, error: String(error?.message || error) };
  }
  if (response.status === 401 && retryAuth) {
    await removeCachedGoogleAuthToken(auth.token);
    return driveRequest(url, options, { interactive, retryAuth: false });
  }
  return { ok: response.ok, response, auth, error: '' };
}
function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
let driveRecoveryCache = { expiresAt: 0, key: '', value: null };
function invalidateDriveRecoveryCache() { driveRecoveryCache = { expiresAt: 0, key: '', value: null }; }
async function findDriveRecoveryFiles({ interactive = false } = {}) {
  const q = `name = '${escapeDriveQueryValue(TOKEN_RECOVERY_FILE_NAME)}' and trashed = false`;
  const url = `${DRIVE_API_BASE}/files?spaces=appDataFolder&pageSize=100&fields=files(id,name,modifiedTime,appProperties)&q=${encodeURIComponent(q)}`;
  const request = await driveRequest(url, { method: 'GET', headers: { Accept: 'application/json' } }, { interactive });
  if (!request.ok) {
    return { ...request.auth, files: [], error: request.response ? await responseError(request.response, 'Google Drive recovery lookup') : request.error };
  }
  const payload = await request.response.json();
  const files = (Array.isArray(payload?.files) ? payload.files : [])
    .filter(file => file?.id)
    .sort((left, right) => String(right.modifiedTime || '').localeCompare(String(left.modifiedTime || '')));
  return { ...request.auth, files, error: '' };
}
function validateDriveRecoveryRecord(value, accountEmail) {
  if (!value || typeof value !== 'object') return { valid: false, token: '', error: 'The Google Drive recovery record is not valid JSON data.' };
  if (String(value.application || '') !== TOKEN_RECOVERY_APP_ID) return { valid: false, token: '', error: 'The Google Drive recovery record belongs to a different BraveFox application.' };
  if (String(value.extensionId || '') !== String(browser.runtime?.id || '')) return { valid: false, token: '', error: 'The Google Drive recovery record belongs to a different extension ID.' };
  if (String(value.accountEmail || '').trim().toLowerCase() !== String(accountEmail || '').trim().toLowerCase()) return { valid: false, token: '', error: 'The Google Drive recovery record belongs to a different approved account.' };
  const token = normalizeToken(value.token);
  if (!token) return { valid: false, token: '', error: 'The Google Drive recovery record does not contain a token.' };
  return { valid: true, token, updatedAt: Number(value.updatedAt) || 0, error: '' };
}
async function readTokenRecovery(access = null, { interactive = false, force = false } = {}) {
  const account = access || await currentPatRecoveryAccess();
  if (!account.allowed) return { supported: true, eligible: false, authorized: false, authorizationRequired: false, hasRecord: false, token: '', error: '', ...account };
  const cacheKey = `${account.email}|${browser.runtime?.id || ''}`;
  if (!force && driveRecoveryCache.value && driveRecoveryCache.key === cacheKey && Date.now() < driveRecoveryCache.expiresAt) return driveRecoveryCache.value;
  const lookup = await findDriveRecoveryFiles({ interactive });
  if (!lookup.authorized) {
    const value = { supported: lookup.supported !== false, eligible: true, authorized: false, authorizationRequired: Boolean(lookup.interactionRequired), hasRecord: false, token: '', error: interactive ? lookup.error : '', authDetail: lookup.error, ...account };
    driveRecoveryCache = { expiresAt: Date.now() + 15000, key: cacheKey, value };
    return value;
  }
  const file = lookup.files[0];
  if (!file) {
    const value = { supported: true, eligible: true, authorized: true, authorizationRequired: false, hasRecord: false, token: '', remoteModifiedTime: '', error: '', ...account };
    driveRecoveryCache = { expiresAt: Date.now() + 30000, key: cacheKey, value };
    return value;
  }
  const request = await driveRequest(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`, { method: 'GET', headers: { Accept: 'application/json' } }, { interactive: false });
  if (!request.ok) {
    const value = { supported: true, eligible: true, authorized: true, authorizationRequired: false, hasRecord: false, token: '', error: request.response ? await responseError(request.response, 'Google Drive recovery download') : request.error, ...account };
    driveRecoveryCache = { expiresAt: Date.now() + 15000, key: cacheKey, value };
    return value;
  }
  let payload;
  try { payload = await request.response.json(); }
  catch { payload = null; }
  const validated = validateDriveRecoveryRecord(payload, account.email);
  const value = {
    supported: true, eligible: true, authorized: true, authorizationRequired: false,
    hasRecord: validated.valid, token: validated.token || '', remoteModifiedTime: String(file.modifiedTime || ''),
    remoteUpdatedAt: validated.updatedAt || 0, error: validated.error || '', ...account
  };
  driveRecoveryCache = { expiresAt: Date.now() + 60000, key: cacheKey, value };
  return value;
}
async function writeTokenRecovery(token, access = null, { interactive = false } = {}) {
  const account = access || await currentPatRecoveryAccess();
  const cleanToken = normalizeToken(token);
  if (!account.allowed) return { supported: true, eligible: false, authorized: false, authorizationRequired: false, ready: false, error: '', ...account };
  if (!cleanToken) return clearTokenRecovery({ access: account, interactive });
  const lookup = await findDriveRecoveryFiles({ interactive });
  if (!lookup.authorized) return { supported: lookup.supported !== false, eligible: true, authorized: false, authorizationRequired: Boolean(lookup.interactionRequired), ready: false, error: lookup.error, ...account };
  let file = lookup.files[0];
  if (!file) {
    const create = await driveRequest(`${DRIVE_API_BASE}/files?fields=id,name,modifiedTime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name: TOKEN_RECOVERY_FILE_NAME,
        parents: ['appDataFolder'],
        mimeType: 'application/json',
        appProperties: { application: TOKEN_RECOVERY_APP_ID, extensionId: String(browser.runtime?.id || '') }
      })
    }, { interactive: false });
    if (!create.ok) return { supported: true, eligible: true, authorized: true, authorizationRequired: false, ready: false, error: create.response ? await responseError(create.response, 'Google Drive recovery file creation') : create.error, ...account };
    file = await create.response.json();
  }
  const record = tokenRecoveryRecord(cleanToken, account.email);
  const upload = await driveRequest(`${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(file.id)}?uploadType=media&fields=id,name,modifiedTime`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(record)
  }, { interactive: false });
  if (!upload.ok) return { supported: true, eligible: true, authorized: true, authorizationRequired: false, ready: false, error: upload.response ? await responseError(upload.response, 'Google Drive recovery upload') : upload.error, ...account };
  const uploaded = await upload.response.json().catch(() => ({}));
  for (const duplicate of lookup.files.slice(file.id === lookup.files[0]?.id ? 1 : 0)) {
    if (duplicate.id === file.id) continue;
    void driveRequest(`${DRIVE_API_BASE}/files/${encodeURIComponent(duplicate.id)}`, { method: 'DELETE' }, { interactive: false });
  }
  invalidateDriveRecoveryCache();
  return { supported: true, eligible: true, authorized: true, authorizationRequired: false, ready: true, hasRecord: true, token: cleanToken, remoteModifiedTime: String(uploaded.modifiedTime || ''), remoteUpdatedAt: record.updatedAt, error: '', ...account };
}
async function clearTokenRecovery({ access = null, interactive = false } = {}) {
  const account = access || await currentPatRecoveryAccess();
  if (!account.allowed) return { supported: true, eligible: false, authorized: false, authorizationRequired: false, ready: false, error: '', ...account };
  const lookup = await findDriveRecoveryFiles({ interactive });
  if (!lookup.authorized) return { supported: lookup.supported !== false, eligible: true, authorized: false, authorizationRequired: Boolean(lookup.interactionRequired), ready: false, error: interactive ? lookup.error : '', authDetail: lookup.error, ...account };
  let error = '';
  for (const file of lookup.files) {
    const request = await driveRequest(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }, { interactive: false });
    if (!request.ok && request.response?.status !== 404) error = request.response ? await responseError(request.response, 'Google Drive recovery deletion') : request.error;
  }
  invalidateDriveRecoveryCache();
  return { supported: true, eligible: true, authorized: true, authorizationRequired: false, ready: false, hasRecord: false, error, ...account };
}
async function readConfigRecord({ checkRecovery = false } = {}) {
  const result = await browser.storage.local.get([CONFIG_KEY, TOKEN_VAULT_KEY, TOKEN_RECOVERY_META_KEY]);
  const raw = result[CONFIG_KEY];
  const vault = result[TOKEN_VAULT_KEY];
  const previousMeta = result[TOKEN_RECOVERY_META_KEY] && typeof result[TOKEN_RECOVERY_META_KEY] === 'object' ? result[TOKEN_RECOVERY_META_KEY] : {};
  const hasVaultRecord = Boolean(vault && typeof vault === 'object' && Object.hasOwn(vault, 'token'));
  const legacyToken = normalizeToken(raw?.token);
  const vaultToken = hasVaultRecord ? normalizeToken(vault.token) : '';
  const recoveryEnabled = raw?.tokenRecovery !== false;
  const access = await currentPatRecoveryAccess();
  const localToken = hasVaultRecord ? vaultToken : legacyToken;
  let recovery = {
    supported: previousMeta.supported !== false,
    eligible: access.allowed,
    authorized: Boolean(previousMeta.authorized),
    authorizationRequired: Boolean(previousMeta.authorizationRequired),
    hasRecord: Boolean(previousMeta.hasRecord),
    token: '',
    remoteModifiedTime: String(previousMeta.remoteModifiedTime || ''),
    remoteUpdatedAt: Number(previousMeta.remoteUpdatedAt) || 0,
    error: String(previousMeta.error || ''),
    ...access
  };
  const shouldCheckRecovery = recoveryEnabled && access.allowed && (!localToken || checkRecovery);
  if (shouldCheckRecovery) recovery = await readTokenRecovery(access, { force: checkRecovery });
  const recoveryToken = recoveryEnabled && access.allowed && recovery.hasRecord ? normalizeToken(recovery.token) : '';
  const recoveredFromGoogleDrive = !localToken && Boolean(recoveryToken);
  const resolvedToken = localToken || recoveryToken;
  const config = normalizeConfig({ ...(raw || DEFAULT_CONFIG), token: resolvedToken, tokenRecovery: recoveryEnabled });
  const repairs = {};
  if (!hasVaultRecord && resolvedToken) repairs[TOKEN_VAULT_KEY] = tokenVaultRecord(resolvedToken);
  if (normalizeToken(raw?.token) !== resolvedToken || raw?.tokenRecovery !== config.tokenRecovery) repairs[CONFIG_KEY] = config;
  if (shouldCheckRecovery) repairs[TOKEN_RECOVERY_META_KEY] = {
    supported: recovery.supported !== false,
    authorized: Boolean(recovery.authorized),
    authorizationRequired: Boolean(recovery.authorizationRequired),
    hasRecord: Boolean(recovery.hasRecord),
    remoteModifiedTime: String(recovery.remoteModifiedTime || ''),
    remoteUpdatedAt: Number(recovery.remoteUpdatedAt) || 0,
    error: String(recovery.error || ''),
    accountEmail: access.email,
    checkedAt: Date.now()
  };
  if (Object.keys(repairs).length) await browser.storage.local.set(repairs);
  return {
    config,
    hasProfileSetting: Boolean(raw && Object.hasOwn(raw, 'activeProfile')),
    tokenVaultReady: hasVaultRecord || Boolean(resolvedToken),
    recoveredFromGoogleDrive,
    recoverySupported: recovery.supported !== false,
    recoveryEligible: access.allowed,
    recoveryAuthorized: Boolean(recovery.authorized),
    recoveryAuthorizationRequired: Boolean(recovery.authorizationRequired),
    recoveryAccountEmail: access.email,
    recoveryBlockedReason: access.blockedReason,
    recoveryReady: Boolean(access.allowed && config.tokenRecovery && resolvedToken && recovery.hasRecord && (!recovery.token || recovery.token === resolvedToken)),
    recoveryRemoteModifiedTime: String(recovery.remoteModifiedTime || ''),
    recoveryError: String(recovery.error || '')
  };
}
async function readConfig() { return (await readConfigRecord()).config; }
async function writeConfig(config, { persistToken = false, reconcileRecovery = false, interactiveRecovery = false } = {}) {
  const clean = normalizeConfig(config);
  const changes = { [CONFIG_KEY]: clean };
  if (persistToken) changes[TOKEN_VAULT_KEY] = tokenVaultRecord(clean.token);
  await browser.storage.local.set(changes);
  if (persistToken || reconcileRecovery) {
    const access = await currentPatRecoveryAccess();
    let recoveryState;
    if (clean.tokenRecovery && clean.token) recoveryState = await writeTokenRecovery(clean.token, access, { interactive: interactiveRecovery });
    else recoveryState = await clearTokenRecovery({ access, interactive: interactiveRecovery });
    await browser.storage.local.set({
      [TOKEN_RECOVERY_META_KEY]: {
        supported: recoveryState.supported !== false,
        authorized: Boolean(recoveryState.authorized),
        authorizationRequired: Boolean(recoveryState.authorizationRequired),
        hasRecord: Boolean(recoveryState.ready || recoveryState.hasRecord),
        remoteModifiedTime: String(recoveryState.remoteModifiedTime || ''),
        remoteUpdatedAt: Number(recoveryState.remoteUpdatedAt) || 0,
        error: String(recoveryState.error || ''),
        accountEmail: access.email,
        checkedAt: Date.now()
      }
    });
  }
  return clean;
}
async function readState(config = null) { const current = config || await readConfig(); const result = await browser.storage.local.get(STATE_KEY); return normalizeState(result[STATE_KEY] || DEFAULT_STATE, current.activeProfile); }
async function writeState(state, config = null) { const current = config || await readConfig(); const clean = normalizeState(state, current.activeProfile); await browser.storage.local.set({ [STATE_KEY]: clean }); return clean; }

let profileIdentityCache = { expiresAt: 0, value: null };
async function detectBrowserProfileEmail({ force = false } = {}) {
  if (INCOGNITO_CONTEXT) {
    const value = { available: false, email: '', profile: '', recoveryAllowed: false };
    profileIdentityCache = { expiresAt: Date.now() + 30000, value };
    return value;
  }
  if (!force && profileIdentityCache.value && Date.now() < profileIdentityCache.expiresAt) return profileIdentityCache.value;
  const identity = browser.identity;
  if (!identity?.getProfileUserInfo) {
    const value = { available: false, email: '', profile: '', recoveryAllowed: false };
    profileIdentityCache = { expiresAt: Date.now() + 30000, value };
    return value;
  }
  const info = await new Promise(resolve => {
    let finished = false;
    const done = value => { if (!finished) { finished = true; resolve(value || {}); } };
    try {
      const maybe = identity.getProfileUserInfo({ accountStatus: 'ANY' }, done);
      if (maybe?.then) maybe.then(done).catch(() => done({}));
    } catch {
      try { identity.getProfileUserInfo(done); } catch { done({}); }
    }
    setTimeout(() => done({}), 1500);
  });
  const email = String(info?.email || '').trim().toLowerCase();
  const value = {
    available: true,
    email,
    profile: profileForEmail(email),
    recoveryAllowed: PAT_RECOVERY_ALLOWED_EMAILS.includes(email)
  };
  profileIdentityCache = { expiresAt: Date.now() + (email ? 30000 : 3000), value };
  return value;
}

async function refreshProfileDetection({ allowInitialSelection = false, includeRecord = false } = {}) {
  const record = await readConfigRecord({ checkRecovery: includeRecord });
  let config = record.config;
  const detected = await detectBrowserProfileEmail();
  const patch = { ...config, detectionAvailable: detected.available, detectedEmail: detected.email };
  if (detected.profile) {
    if (allowInitialSelection && !record.hasProfileSetting && !config.profileExplicit) {
      patch.activeProfile = detected.profile;
      patch.suggestedProfile = '';
    } else if (detected.profile !== config.activeProfile) patch.suggestedProfile = detected.profile;
    else patch.suggestedProfile = '';
  } else patch.suggestedProfile = '';
  config = await writeConfig(patch);
  return includeRecord ? { config, record } : config;
}

function apiUrl(kind, profileId) {
  const file = fileFor(normalizeKind(kind), profileId);
  const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(GITHUB_SYNC_TARGET.owner)}/${encodeURIComponent(GITHUB_SYNC_TARGET.repository)}/contents/${encodedPath}`;
}
function githubHeaders(token = '') { const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; if (token) headers.Authorization = `Bearer ${token}`; return headers; }
function encodeBase64Utf8(text) { const bytes = new TextEncoder().encode(String(text || '')); let binary=''; for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(binary); }
function decodeBase64Utf8(base64) { const binary=atob(String(base64||'').replace(/\s+/g,'')); const bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i); return new TextDecoder().decode(bytes); }

async function fetchRawKind(kind, profileId) {
  const file = fileFor(normalizeKind(kind), profileId);
  const response = await fetch(`${file.rawUrl}?bravefox_refresh=${Date.now()}`, { cache:'no-store', credentials:'omit', headers:{Accept:'text/plain'} });
  if (!response.ok) throw new Error(`GitHub raw ${kind} download failed (HTTP ${response.status}).`);
  return parseListText(await response.text(), kind);
}
async function fetchRawLists({ profileId = 'haukkis', bundledFallback = false, includeTerms = true, includeLinks = true } = {}) {
  const profile = normalizeProfile(profileId);
  const tasks = [includeTerms ? fetchRawKind('terms', profile) : Promise.resolve(null), includeLinks ? fetchRawKind('links', profile) : Promise.resolve(null)];
  const results = await Promise.allSettled(tasks);
  let terms = includeTerms && results[0].status === 'fulfilled' ? results[0].value : null;
  let links = includeLinks && results[1].status === 'fulfilled' ? results[1].value : null;
  let usedBundledFallback = false;
  if (bundledFallback && ((includeTerms && terms === null) || (includeLinks && links === null))) {
    const bundled = await loadBundledFallbackLists(profile);
    if (includeTerms && terms === null) terms = bundled.terms;
    if (includeLinks && links === null) links = bundled.links;
    usedBundledFallback = true;
  }
  if (includeTerms && terms === null) throw results[0].reason || new Error('GitHub terms download failed.');
  if (includeLinks && links === null) throw results[1].reason || new Error('GitHub links download failed.');
  return { terms, links, profile, usedBundledFallback };
}

async function fetchApiKind(kind, token, profileId) {
  const response = await fetch(`${apiUrl(kind, profileId)}?ref=${encodeURIComponent(GITHUB_SYNC_TARGET.branch)}`, { cache:'no-store', credentials:'omit', headers:githubHeaders(token) });
  if (response.status === 404) return { exists:false, sha:'', values:[] };
  if (!response.ok) { const detail=await response.text().catch(()=> ''); throw new Error(`GitHub API ${kind} read failed (HTTP ${response.status})${detail?`: ${detail.slice(0,180)}`:''}`); }
  const payload=await response.json();
  if (payload?.type !== 'file' || typeof payload.content !== 'string') throw new Error(`GitHub ${kind} path is not a readable file.`);
  return { exists:true, sha:String(payload.sha||''), values:parseListText(decodeBase64Utf8(payload.content),kind) };
}
async function putApiKind(kind, token, values, sha, profileId) {
  const file=fileFor(kind,profileId);
  const body={ message:`Sync BraveFox Focus Master ${file.path.split('/').pop()}`, content:encodeBase64Utf8(serializeListCsv(values)), branch:GITHUB_SYNC_TARGET.branch };
  if (sha) body.sha=sha;
  const response=await fetch(apiUrl(kind,profileId),{method:'PUT',credentials:'omit',headers:{...githubHeaders(token),'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (response.status===409 || response.status===422) { const error=new Error(`GitHub ${kind} update conflicted with a newer revision.`); error.code='conflict'; throw error; }
  if (!response.ok) { const detail=await response.text().catch(()=> ''); throw new Error(`GitHub ${kind} upload failed (HTTP ${response.status})${detail?`: ${detail.slice(0,180)}`:''}`); }
  return response.json();
}
function arraysEqual(left,right){return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((v,i)=>v===right[i]);}
async function saveDatasetIfChanged(current,next,profile){
  const terms=uniqueInOrder(next.terms,normalizeTerm), links=uniqueInOrder(next.links,normalizeLinkForStorage), normalizedProfile=normalizeProfile(profile||current?.profile);
  if (arraysEqual(current?.terms,terms)&&arraysEqual(current?.links,links)&&current?.profile===normalizedProfile) return current;
  return saveDataset({terms,links,profile:normalizedProfile});
}
function scopeFor(kind,profile){return kind==='terms'?normalizeProfile(profile):'global';}
function pendingFor(state,kind,profile){const scope=scopeFor(kind,profile);return state.pending.filter(item=>item.kind===kind&&item.profile===scope);}
function forceFor(state,kind,profile){return kind==='links'?state.forceSnapshot.links:Boolean(state.forceSnapshot.terms[normalizeProfile(profile)]);}
function setForce(state,kind,profile,value){const next={...state,forceSnapshot:{links:state.forceSnapshot.links,terms:{...state.forceSnapshot.terms}}};if(kind==='links')next.forceSnapshot.links=Boolean(value);else next.forceSnapshot.terms[normalizeProfile(profile)]=Boolean(value);return next;}
function clearPending(state,kind,profile){const scope=scopeFor(kind,profile);return setForce({...state,pending:state.pending.filter(item=>!(item.kind===kind&&item.profile===scope))},kind,profile,false);}
function applyOperations(values,kind,operations){const normalize=normalizerFor(kind);let next=uniqueInOrder(values,normalize);for(const op of operations){const value=normalize(op.value);if(!value)continue;if(op.action==='remove')next=next.filter(item=>normalize(item)!==value);else if(!next.some(item=>normalize(item)===value))next.push(value);}return next;}
async function hasRequiredDataConsent(){const manifest=browser.runtime.getManifest();if(!manifest?.browser_specific_settings?.gecko)return true;try{const permissions=await browser.permissions.getAll();const granted=new Set(Array.isArray(permissions.data_collection)?permissions.data_collection:[]);return REQUIRED_DATA_COLLECTION.every(item=>granted.has(item));}catch{return false;}}
async function uploadExactKind(kind,token,values,profile){for(let attempt=0;attempt<3;attempt++){const remote=await fetchApiKind(kind,token,profile);try{await putApiKind(kind,token,uniqueInOrder(values,normalizerFor(kind)),remote.sha,profile);return uniqueInOrder(values,normalizerFor(kind));}catch(error){if(error.code!=='conflict'||attempt===2)throw error;}}return values;}
async function uploadMergedKind(kind,token,current,state,profile){for(let attempt=0;attempt<3;attempt++){const remote=await fetchApiKind(kind,token,profile);const values=forceFor(state,kind,profile)?uniqueInOrder(current,normalizerFor(kind)):applyOperations(remote.values,kind,pendingFor(state,kind,profile));try{await putApiKind(kind,token,values,remote.sha,profile);return values;}catch(error){if(error.code!=='conflict'||attempt===2)throw error;}}return current;}
async function setStatus(state,{action='',error='',synced=false}={}){return writeState({...state,lastAction:action||state.lastAction,lastError:String(error||''),lastSyncAt:synced?Date.now():state.lastSyncAt});}

export async function getGitHubSyncStatus(){
  const refreshed=await refreshProfileDetection({includeRecord:true}); const config=refreshed.config; const record=refreshed.record; const state=await readState(config); const profile=SYNC_PROFILES[config.activeProfile]; const trusted=getTrustedSitesStatus();
  return {
    autoSync:config.autoSync,hasToken:Boolean(config.token),tokenRecovery:config.tokenRecovery,recoverySupported:record.recoverySupported,recoveryEligible:record.recoveryEligible,recoveryAuthorized:record.recoveryAuthorized,recoveryAuthorizationRequired:record.recoveryAuthorizationRequired,recoveryAccountEmail:record.recoveryAccountEmail,recoveryBlockedReason:record.recoveryBlockedReason,recoveryReady:record.recoveryReady,recoveredFromGoogleDrive:record.recoveredFromGoogleDrive,recoveryRemoteModifiedTime:record.recoveryRemoteModifiedTime,recoveryError:record.recoveryError,activeProfile:config.activeProfile,activeProfileLabel:profile.label,
    termsProfile:state.termsProfile,termsProfileLabel:SYNC_PROFILES[state.termsProfile].label,
    profileSwitchPending:config.profileSwitchPending,suggestedProfile:config.suggestedProfile,
    suggestedProfileLabel:config.suggestedProfile?SYNC_PROFILES[config.suggestedProfile].label:'',
    detectedEmail:config.detectedEmail,detectionAvailable:config.detectionAvailable,
    profiles:Object.values(SYNC_PROFILES).map(item=>({id:item.id,label:item.label,termsFile:item.termsFile,emails:[...item.emails]})),
    pendingCount:state.pending.length+Number(state.forceSnapshot.links)+Number(state.forceSnapshot.terms.haukkis)+Number(state.forceSnapshot.terms.tapsa),
    lastSyncAt:state.lastSyncAt,lastAction:state.lastAction,lastError:state.lastError,
    trustedSites:trusted,
    target:{owner:GITHUB_SYNC_TARGET.owner,repository:GITHUB_SYNC_TARGET.repository,branch:GITHUB_SYNC_TARGET.branch,files:{terms:termsTarget(config.activeProfile),links:GITHUB_SYNC_TARGET.files.links,trustedSites:GITHUB_SYNC_TARGET.files.trustedSites}}
  };
}

export async function saveGitHubSyncConfig(patch={}){
  let config=await readConfig();
  const next={...config};
  if(Object.hasOwn(patch,'autoSync'))next.autoSync=patch.autoSync!==false;
  const tokenRecoveryChanged=Object.hasOwn(patch,'tokenRecovery')&&Boolean(patch.tokenRecovery)!==config.tokenRecovery;
  if(Object.hasOwn(patch,'tokenRecovery'))next.tokenRecovery=Boolean(patch.tokenRecovery);
  let tokenChanged=false;
  if(patch.clearToken){next.token='';tokenChanged=true;}
  else if(String(patch.token||'').trim()){next.token=String(patch.token).trim();tokenChanged=true;}
  if(Object.hasOwn(SYNC_PROFILES, patch.activeProfile)){
    const requested=normalizeProfile(patch.activeProfile);
    if(requested!==config.activeProfile){
      if(!patch.confirmProfileSwitch)throw new Error(`Confirm switching Sync Profile from ${SYNC_PROFILES[config.activeProfile].label} to ${SYNC_PROFILES[requested].label}.`);
      next.previousProfile=config.activeProfile; next.activeProfile=requested; next.profileSwitchPending=true; next.profileExplicit=true; next.suggestedProfile='';
    } else if(patch.profileExplicit) next.profileExplicit=true;
  }
  config=await writeConfig(next,{persistToken:tokenChanged,reconcileRecovery:tokenChanged||tokenRecoveryChanged,interactiveRecovery:Boolean(patch.interactiveRecovery)}); setupGitHubSyncAlarms(config); return getGitHubSyncStatus();
}

export async function queueRemoteOperation(kind,action,value){
  normalizeKind(kind); if(action!=='add'&&action!=='remove')throw new Error('Unknown GitHub queue operation.');
  const config=await readConfig(); let state=await readState(config); const profile=kind==='terms'?state.termsProfile:'global'; const normalized=normalizerFor(kind)(value); if(!normalized)return state;
  state.pending=state.pending.filter(item=>!(item.kind===kind&&item.profile===profile&&normalizerFor(kind)(item.value)===normalized));
  state.pending.push({id:`${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`,kind,profile,action,value:normalized,createdAt:Date.now()});
  state=await writeState(state,config); if(config.autoSync)scheduleAutomaticGitHubSync(); return state;
}
export async function queueRemoteSnapshot(kind){
  normalizeKind(kind); const config=await readConfig(); let state=await readState(config); const profile=kind==='terms'?state.termsProfile:'global';
  state=setForce(state,kind,profile,true); state.pending=state.pending.filter(item=>!(item.kind===kind&&item.profile===profile)); state=await writeState(state,config); if(config.autoSync)scheduleAutomaticGitHubSync(); return state;
}
export function scheduleAutomaticGitHubSync(){try{browser.alarms.clear(DEBOUNCED_SYNC_ALARM);browser.alarms.create(DEBOUNCED_SYNC_ALARM,{when:Date.now()+DEBOUNCE_MS});}catch{}}

export async function downloadGitHubLists({allowBundledFallback=true}={}){
  let config=await readConfig(); const profile=config.activeProfile; const downloaded=await fetchRawLists({profileId:profile,bundledFallback:allowBundledFallback});
  const dataset=await saveDataset({terms:downloaded.terms,links:downloaded.links,profile}); let state=await readState(config);
  state=clearPending(state,'terms',profile); state=clearPending(state,'links','global'); state.termsProfile=profile; state.initializedProfiles[profile]=true; state.initializedLinks=true;
  state=await setStatus(state,{action:downloaded.usedBundledFallback?'Loaded packaged fallback lists':'Downloaded from GitHub',synced:true});
  config=await writeConfig({...config,profileSwitchPending:false,previousProfile:''});
  await refreshTrustedSites({reason:'manual GitHub download'});
  return {dataset,state,usedBundledFallback:downloaded.usedBundledFallback};
}

export async function uploadGitHubLists(){
  let config=await readConfig(); if(!config.token)throw new Error('Enter and save a fine-grained GitHub token before uploading.'); if(!(await hasRequiredDataConsent()))throw new Error('GitHub upload permission has not been granted.');
  const profile=config.activeProfile; const local=await loadDataset({force:true}); let state=await readState(config);
  const terms=await uploadExactKind('terms',config.token,local.terms,profile); state=clearPending(state,'terms',profile); await writeState(state,config);
  const links=await uploadExactKind('links',config.token,local.links,'global'); state=clearPending(state,'links','global'); state.termsProfile=profile; state.initializedProfiles[profile]=true; state.initializedLinks=true;
  state=await setStatus(state,{action:'Uploaded to GitHub',synced:true}); config=await writeConfig({...config,profileSwitchPending:false,previousProfile:''});
  const dataset=await saveDatasetIfChanged(local,{terms,links},profile); await refreshTrustedSites({reason:'manual GitHub upload'}); return {dataset,state};
}

async function initializeKind(kind,profile,current,state,canUpload){
  const remote=await fetchRawKind(kind,profile).catch(async()=>{const bundled=await loadBundledFallbackLists(profile);return kind==='terms'?bundled.terms:bundled.links;});
  const normalize=normalizerFor(kind); const merged=uniqueInOrder([...remote,...current],normalize); const hasLocalExtra=current.some(value=>!remote.includes(normalize(value)));
  state=setForce(state,kind,profile,hasLocalExtra); if(kind==='terms')state.initializedProfiles[normalizeProfile(profile)]=true;else state.initializedLinks=true;
  if(hasLocalExtra&&canUpload){const uploaded=await uploadExactKind(kind,(await readConfig()).token,merged,profile);state=clearPending(state,kind,profile);return{values:uploaded,state};}
  return{values:merged,state};
}

async function syncKind(kind,profile,current,state,canUpload){
  const hasPending=forceFor(state,kind,profile)||pendingFor(state,kind,profile).length>0;
  if(hasPending&&canUpload){const values=await uploadMergedKind(kind,(await readConfig()).token,current,state,profile);return{values,state:clearPending(state,kind,profile),uploaded:true};}
  const remote=await fetchRawKind(kind,profile);
  if(hasPending){const values=forceFor(state,kind,profile)?current:applyOperations(remote,kind,pendingFor(state,kind,profile));return{values,state,warning:'Pending changes are local until a token and upload consent are available.'};}
  return{values:remote,state};
}

async function runAutomaticSyncInternal(){
  let config=await refreshProfileDetection(); if(!config.autoSync)return{skipped:true,reason:'Automatic sync is disabled.'};
  await initializeTrustedSites(); await refreshTrustedSites({reason:'automatic sync'}).catch(()=>{});
  let state=await readState(config); const local=await loadDataset({force:true}); const canUpload=Boolean(config.token)&&await hasRequiredDataConsent();
  const termsEnabled=!config.profileSwitchPending&&state.termsProfile===config.activeProfile; let terms=local.terms,links=local.links; let warning=''; let uploaded=false;
  try{
    if(termsEnabled){
      if(!state.initializedProfiles[config.activeProfile]){const result=await initializeKind('terms',config.activeProfile,terms,state,canUpload);terms=result.values;state=result.state;}
      else{const result=await syncKind('terms',config.activeProfile,terms,state,canUpload);terms=result.values;state=result.state;warning=warning||result.warning||'';uploaded=uploaded||result.uploaded;}
    } else if(config.profileSwitchPending) warning=`Sync Profile changed to ${SYNC_PROFILES[config.activeProfile].label}; terms remain on ${SYNC_PROFILES[state.termsProfile].label} until manual Download or Upload.`;
    if(!state.initializedLinks){const result=await initializeKind('links','global',links,state,canUpload);links=result.values;state=result.state;}
    else{const result=await syncKind('links','global',links,state,canUpload);links=result.values;state=result.state;warning=warning||result.warning||'';uploaded=uploaded||result.uploaded;}
    state=await writeState(state,config); const dataset=await saveDatasetIfChanged(local,{terms,links},state.termsProfile);
    state=await setStatus(state,{action:uploaded?'Automatic GitHub upload':'Automatic GitHub download',error:warning,synced:true});
    return{dataset,state,direction:uploaded?'upload':'download'};
  }catch(error){state=await setStatus(state,{action:state.lastAction||'Automatic GitHub sync',error:String(error?.message||error),synced:false});throw error;}
}
export async function runAutomaticGitHubSync(){if(INCOGNITO_CONTEXT)return{skipped:true,reason:'GitHub sync is disabled in Incognito.'};if(syncPromise)return syncPromise;syncPromise=runAutomaticSyncInternal().finally(()=>{syncPromise=null;});return syncPromise;}
function setupGitHubSyncAlarms(config=DEFAULT_CONFIG){if(config.autoSync)browser.alarms.create(AUTO_SYNC_ALARM,{periodInMinutes:AUTO_SYNC_INTERVAL_MINUTES});else{void browser.alarms.clear(AUTO_SYNC_ALARM);void browser.alarms.clear(DEBOUNCED_SYNC_ALARM);}}
export async function initializeGitHubSync(){if(INCOGNITO_CONTEXT){void browser.alarms.clear(AUTO_SYNC_ALARM);void browser.alarms.clear(DEBOUNCED_SYNC_ALARM);void browser.alarms.clear(PAT_RECOVERY_RETRY_ALARM);await initializeTrustedSites();return{skipped:true,incognito:true,reason:'Management sync and profile detection are disabled in Incognito.'};}const config=await refreshProfileDetection({allowInitialSelection:true});const state=await readState(config);if(!state.termsProfile)state.termsProfile=config.activeProfile;await writeState(state,config);setupGitHubSyncAlarms(config);if(config.tokenRecovery&&!config.token){try{browser.alarms.create(PAT_RECOVERY_RETRY_ALARM,{when:Date.now()+30000});}catch{}}else{void browser.alarms.clear(PAT_RECOVERY_RETRY_ALARM);}await initializeTrustedSites();if(config.autoSync)scheduleAutomaticGitHubSync();return getGitHubSyncStatus();}
browser.alarms.onAlarm.addListener(alarm=>{if(INCOGNITO_CONTEXT)return;if(alarm.name!==AUTO_SYNC_ALARM&&alarm.name!==DEBOUNCED_SYNC_ALARM&&alarm.name!==PAT_RECOVERY_RETRY_ALARM)return;void runAutomaticGitHubSync().catch(error=>console.warn(`${LOG_PREFIX} Automatic sync failed; the last valid local lists remain active:`,error));});
browser.runtime.onStartup.addListener(()=>{if(!INCOGNITO_CONTEXT)void initializeGitHubSync();});
browser.runtime.onInstalled.addListener(()=>{if(!INCOGNITO_CONTEXT)void initializeGitHubSync();});
