import { BLOCKER_VERSION, MESSAGE, STORAGE_KEYS } from './constants.js';
import {
  cleanupTabAuth,
  establishManagerSession,
  isAdminTabUnlocked,
  isManagerTabUnlocked,
  isRegisteredManagerTab,
  lockAdminTab,
  lockManagerTab,
  reauthenticateManagerTab,
  registerManagerTab,
  touchAdminTab,
  unlockAdminTab,
  verifyPassword
} from './auth.js';
import { findBlockReason } from './matcher.js';
import {
  getSettings,
  invalidateDatasetCache,
  loadDataset,
  saveDataset,
  synchronizeNow,
  updateSettings
} from './storage.js';
import {
  isCompletelyExcludedUrl,
  isIncognitoSender,
  isSupportedWebUrl,
  normalizeLinkForStorage,
  normalizeTerm,
  uniqueInOrder
} from './shared.js';

const recentlyRedirected = new Map();
const redirectInFlight = new Set();
const redirectLandingBypass = new Map();
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;

// ---------------------------------------------------------------------------
// Native redirect logging
// ---------------------------------------------------------------------------
const NATIVE_LOGGER_HOST = 'com.bravefox.redirect_logger';
const NATIVE_LOG_SOURCE = chrome.runtime.getManifest().name === 'BraveFox Focus Master'
  ? 'BraveFox Focus Master'
  : 'BraveFox Focus Master (BFE)';
const recentNativeLogKeys = new Map();

function cleanNativeLogText(value, maxLength = 1000) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function escapeNativeLogRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightNativeLogSearch(value, trigger) {
  let output = cleanNativeLogText(value, 1000);
  const tokens = [...new Set(
    cleanNativeLogText(trigger, 240)
      .split(/\s+/)
      .map(token => token.trim())
      .filter(Boolean)
  )].sort((a, b) => b.length - a.length);

  for (const token of tokens) {
    try {
      output = output.replace(new RegExp(escapeNativeLogRegex(token), 'ig'), match => `*${match}*`);
    } catch {}
  }
  return output;
}

function pruneNativeLogKeys() {
  const cutoff = Date.now() - 10_000;
  for (const [key, timestamp] of recentNativeLogKeys.entries()) {
    if (timestamp < cutoff) recentNativeLogKeys.delete(key);
  }
}

function sendNativeBlockLog(reason, sourceUrl, redirectTarget = '') {
  if (!reason || typeof chrome.runtime?.sendNativeMessage !== 'function') return;

  const blockedWord = cleanNativeLogText(reason.trigger, 240);
  const attemptedSearch = highlightNativeLogSearch(reason.attemptedSearch, blockedWord);
  const pageUrl = cleanNativeLogText(sourceUrl, 1000);
  const key = `${reason.type || ''}::${blockedWord}::${attemptedSearch}::${pageUrl}`;

  pruneNativeLogKeys();
  if (recentNativeLogKeys.has(key)) return;
  recentNativeLogKeys.set(key, Date.now());

  const payload = {
    type: 'BRAVEFOX_REDIRECT_LOG',
    source: NATIVE_LOG_SOURCE,
    blockedWord,
    attemptedSearch,
    context: reason.type === 'link' ? 'blocked-link' : 'blocked-term',
    pageUrl,
    referrer: cleanNativeLogText(redirectTarget, 1000),
    timestamp: new Date().toISOString()
  };

  try {
    chrome.runtime.sendNativeMessage(NATIVE_LOGGER_HOST, payload, () => {
      // Accessing lastError suppresses the default console warning. Blocking must
      // continue normally when the optional native logger is not installed.
      void chrome.runtime.lastError;
    });
  } catch {}
}


function senderUrl(sender) { return String(sender?.url || sender?.tab?.url || ''); }
function senderTabId(sender) { return Number.isInteger(sender?.tab?.id) ? sender.tab.id : null; }
function senderIsInternalPage(sender, pathname) {
  try {
    const url = new URL(senderUrl(sender));
    return sender?.id === chrome.runtime.id && url.origin === EXTENSION_ORIGIN && url.pathname === pathname;
  } catch { return false; }
}
function senderIsManager(sender) { return senderIsInternalPage(sender, '/blocker/manager.html'); }
function senderIsPopup(sender) { return senderIsInternalPage(sender, '/blocker/popup.html'); }
function senderIsPasswordPage(sender, target) {
  try {
    const url = new URL(senderUrl(sender));
    return sender?.id === chrome.runtime.id && url.origin === EXTENSION_ORIGIN &&
      url.pathname === '/html/password-protected.html' && url.searchParams.get('target') === target;
  } catch { return false; }
}

function requireManagerSender(sender) {
  if (!senderIsManager(sender)) throw new Error('Management request denied.');
  if (isIncognitoSender(sender)) throw new Error('Management is unavailable in Incognito.');
  const tabId = senderTabId(sender);
  if (tabId === null) throw new Error('Manager tab could not be identified.');
  return tabId;
}

async function requireManagerAccess(sender) {
  const tabId = requireManagerSender(sender);
  if (!(await isManagerTabUnlocked(tabId))) throw new Error('BraveFox Focus Master is locked.');
  return tabId;
}

async function requireAdminAccess(sender) {
  const tabId = await requireManagerAccess(sender);
  if (!(await isAdminTabUnlocked(tabId))) throw new Error('Settings are locked.');
  await touchAdminTab(tabId);
  return tabId;
}

function publicCounts(dataset) { return { termCount: dataset.terms.length, linkCount: dataset.links.length }; }
function publicStorageStatus(dataset) {
  return {
    syncPending: Boolean(dataset.syncPending),
    syncError: String(dataset.syncError || ''),
    updatedAt: Number(dataset.updatedAt) || 0,
    revision: String(dataset.revision || '')
  };
}

async function bootstrapManager(sender) {
  const tabId = requireManagerSender(sender);
  const registered = await isRegisteredManagerTab(tabId);
  const unlocked = registered && await isManagerTabUnlocked(tabId);
  const [settings, dataset] = await Promise.all([getSettings(), loadDataset()]);
  return {
    ok: true,
    version: BLOCKER_VERSION,
    registered,
    unlocked,
    adminUnlocked: unlocked && await isAdminTabUnlocked(tabId),
    settings,
    ...publicCounts(dataset),
    storageStatus: publicStorageStatus(dataset),
    incognito: false
  };
}

async function checkManagerAccess(sender) {
  if (!senderIsManager(sender) || isIncognitoSender(sender)) return { ok: true, registered: false, unlocked: false, adminUnlocked: false };
  const tabId = senderTabId(sender);
  if (tabId === null) return { ok: true, registered: false, unlocked: false, adminUnlocked: false };
  const registered = await isRegisteredManagerTab(tabId);
  const unlocked = registered && await isManagerTabUnlocked(tabId);
  return { ok: true, registered, unlocked, adminUnlocked: unlocked && await isAdminTabUnlocked(tabId) };
}

async function fullState(sender) {
  const tabId = await requireManagerAccess(sender);
  const [dataset, settings] = await Promise.all([loadDataset(), getSettings()]);
  return {
    ok: true,
    terms: dataset.terms,
    links: dataset.links,
    settings,
    adminUnlocked: await isAdminTabUnlocked(tabId),
    storageStatus: publicStorageStatus(dataset)
  };
}

function sanitizeAdminPatch(patch) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const output = {};
  for (const key of [
    'enabled', 'blockTerms', 'blockLinks', 'unlockTtlMinutes',
    'redirectTerms', 'redirectTermsUrl', 'redirectLinks', 'redirectLinksUrl'
  ]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = source[key];
  }
  output.lockManager = true;
  return output;
}

async function mutateDataset(kind, operation, payload) {
  if (kind !== 'terms' && kind !== 'links') throw new Error('Unknown list type.');
  const dataset = await loadDataset({ force: true });
  const normalizer = kind === 'links' ? normalizeLinkForStorage : normalizeTerm;
  const current = kind === 'links' ? dataset.links : dataset.terms;
  let next = [...current];
  if (operation === 'add') next = uniqueInOrder([...next, payload.value], normalizer);
  else if (operation === 'remove') {
    const target = normalizer(payload.value);
    next = next.filter(item => normalizer(item) !== target);
  } else if (operation === 'replace') next = uniqueInOrder(payload.values, normalizer);
  else if (operation === 'merge') next = uniqueInOrder([...next, ...payload.values], normalizer);
  else throw new Error('Unknown dataset operation.');

  const saved = await saveDataset({
    terms: kind === 'terms' ? next : dataset.terms,
    links: kind === 'links' ? next : dataset.links
  });
  return { ok: true, terms: saved.terms, links: saved.links, storageStatus: publicStorageStatus(saved) };
}

function normalizedComparableUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.hash = '';
    return parsed.href;
  } catch { return ''; }
}

function shouldBypassRedirect(tabId, url) {
  const entry = redirectLandingBypass.get(tabId);
  if (!entry) return false;
  if (Number(entry.expiresAt) <= Date.now()) {
    redirectLandingBypass.delete(tabId);
    return false;
  }
  return normalizedComparableUrl(entry.url) === normalizedComparableUrl(url);
}

function configuredRedirectTarget(reason, settings, sourceUrl) {
  let configured = '';
  if (reason?.type === 'term' && settings?.redirectTerms) configured = settings.redirectTermsUrl;
  if (reason?.type === 'link' && settings?.redirectLinks) configured = settings.redirectLinksUrl;
  const target = normalizedComparableUrl(configured);
  const source = normalizedComparableUrl(sourceUrl);
  if (!target || target === source) return '';
  return configured;
}

function blockedPageUrl(reason, sourceUrl) {
  const params = new URLSearchParams({
    type: reason.type,
    trigger: reason.trigger,
    source: sourceUrl,
    attempted: reason.attemptedSearch || ''
  });
  return chrome.runtime.getURL(`blocker/blocked.html?${params.toString()}`);
}

async function evaluateNavigation(tabId, url, title = '') {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  if (!isSupportedWebUrl(url) || isCompletelyExcludedUrl(url)) return;
  if (shouldBypassRedirect(tabId, url) || redirectInFlight.has(tabId)) return;
  const last = recentlyRedirected.get(tabId);
  if (last && last.url === url && Date.now() - last.at < 1500) return;

  const [dataset, settings] = await Promise.all([loadDataset(), getSettings()]);
  const reason = findBlockReason({ url, title }, dataset, settings);
  if (!reason) return;

  redirectInFlight.add(tabId);
  recentlyRedirected.set(tabId, { url, at: Date.now() });
  try {
    const directTarget = configuredRedirectTarget(reason, settings, url);
    sendNativeBlockLog(reason, url, directTarget);
    if (directTarget) {
      redirectLandingBypass.set(tabId, { url: directTarget, expiresAt: Date.now() + 15_000 });
      await chrome.tabs.update(tabId, { url: directTarget });
    } else {
      await chrome.tabs.update(tabId, { url: blockedPageUrl(reason, url) });
    }
    try { await chrome.history.deleteUrl({ url }); } catch {}
  } catch (error) {
    console.warn('[BraveFox Focus Master] Redirect failed:', error);
  } finally {
    redirectInFlight.delete(tabId);
  }
}

async function authenticatePopupAndOpen(message, sender) {
  if (!senderIsPopup(sender)) throw new Error('Popup unlock request denied.');
  if (isIncognitoSender(sender)) throw new Error('Management is unavailable in Incognito.');
  if (!(await verifyPassword(message.password))) return { ok: true, unlocked: false };

  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (!Number.isInteger(tab.id)) throw new Error('Could not create the manager tab.');
  try {
    await registerManagerTab(tab.id);
    await establishManagerSession(tab.id);
    await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('blocker/manager.html') });
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
  return { ok: true, unlocked: true };
}

chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId !== 0) return;
  void evaluateNavigation(details.tabId, details.url, '');
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || '';
  const title = changeInfo.title || tab.title || '';
  if (url) void evaluateNavigation(tabId, url, title);
});
chrome.tabs.onRemoved.addListener(tabId => {
  recentlyRedirected.delete(tabId);
  redirectInFlight.delete(tabId);
  redirectLandingBypass.delete(tabId);
  void cleanupTabAuth(tabId);
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes[STORAGE_KEYS.datasetMeta] || Object.keys(changes).some(key => key.startsWith('bfb:data:'))) {
      invalidateDatasetCache();
      void loadDataset({ force: true }).catch(() => {});
    }
  } else if (areaName === 'local' && changes[STORAGE_KEYS.localDataset]) invalidateDatasetCache();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type || !String(message.type).startsWith('BFB_')) return;
  (async () => {
    switch (message.type) {
      case MESSAGE.getBootstrap:
        return bootstrapManager(sender);
      case MESSAGE.checkAccess:
        return checkManagerAccess(sender);
      case MESSAGE.getState:
        return fullState(sender);
      case MESSAGE.popupUnlockOpen:
        return authenticatePopupAndOpen(message, sender);
      case MESSAGE.unlock: {
        if (!senderIsPasswordPage(sender, 'blocker-manager')) throw new Error('Unlock request denied.');
        if (isIncognitoSender(sender)) throw new Error('Management is unavailable in Incognito.');
        const tabId = senderTabId(sender);
        if (tabId === null) throw new Error('Manager tab could not be identified.');
        return { ok: true, unlocked: await reauthenticateManagerTab(message.password, tabId) };
      }
      case MESSAGE.lock: {
        const tabId = await requireManagerAccess(sender);
        await lockManagerTab(tabId);
        return { ok: true };
      }
      case MESSAGE.adminUnlock: {
        const tabId = await requireManagerAccess(sender);
        const adminUnlocked = await unlockAdminTab(message.password, tabId);
        return { ok: true, adminUnlocked, settings: await getSettings() };
      }
      case MESSAGE.adminLock: {
        const tabId = await requireManagerAccess(sender);
        await lockAdminTab(tabId);
        return { ok: true, adminUnlocked: false };
      }
      case MESSAGE.updateAdminSettings: {
        const tabId = await requireAdminAccess(sender);
        return {
          ok: true,
          settings: await updateSettings(sanitizeAdminPatch(message.patch)),
          adminUnlocked: await isAdminTabUnlocked(tabId)
        };
      }
      case MESSAGE.addItem:
        await requireManagerAccess(sender);
        return mutateDataset(message.kind, 'add', { value: message.value });
      case MESSAGE.removeItem:
        await requireManagerAccess(sender);
        return mutateDataset(message.kind, 'remove', { value: message.value });
      case MESSAGE.importList:
        await requireManagerAccess(sender);
        return mutateDataset(message.kind, message.mode === 'replace' ? 'replace' : 'merge', { values: Array.isArray(message.values) ? message.values : [] });
      case MESSAGE.replaceAll: {
        const tabId = await requireAdminAccess(sender);
        const saved = await saveDataset({ terms: message.terms, links: message.links });
        const settings = await updateSettings(sanitizeAdminPatch(message.settings));
        return {
          ok: true,
          terms: saved.terms,
          links: saved.links,
          storageStatus: publicStorageStatus(saved),
          settings,
          settingsRestored: true,
          adminUnlocked: await isAdminTabUnlocked(tabId)
        };
      }
      case MESSAGE.syncNow: {
        const tabId = await requireManagerAccess(sender);
        const result = await synchronizeNow();
        return {
          ok: true,
          terms: result.dataset.terms,
          links: result.dataset.links,
          settings: result.settings,
          adminUnlocked: await isAdminTabUnlocked(tabId),
          storageStatus: publicStorageStatus(result.dataset)
        };
      }
      case MESSAGE.openManager:
        throw new Error('Enter the popup password to open BraveFox Focus Master.');
      default:
        throw new Error('Unknown BraveFox Focus Master message.');
    }
  })().then(result => sendResponse(result)).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

void chrome.storage.sync.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
void chrome.storage.sync.remove(STORAGE_KEYS.auth).catch(() => {});
void loadDataset({ force: true }).catch(error => console.warn('[BraveFox Focus Master] Initial dataset load failed:', error));
console.log(`[BraveFox Focus Master] Module ${BLOCKER_VERSION} initialized with resilient manager re-authentication, password-gated Settings, ordered persistent lists, dual redirects, manual profile sync, and native redirect logging.`);
