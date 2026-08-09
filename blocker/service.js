import { browser } from './api.js';
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
import { findBlockedHost, initializeHosts } from './hosts.js';
import {
  downloadGitHubLists,
  getGitHubSyncStatus,
  initializeGitHubSync,
  queueRemoteOperation,
  queueRemoteSnapshot,
  saveGitHubSyncConfig,
  uploadGitHubLists
} from './github-sync.js';
import {
  getSettings,
  invalidateDatasetCache,
  loadDataset,
  saveDataset,
  synchronizeNow,
  updateSettings
} from './storage.js';
import { initializeTrustedSites } from './trusted-sites.js';
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
const EXTENSION_ORIGIN = new URL(browser.runtime.getURL('/')).origin;

// ---------------------------------------------------------------------------
// Native redirect logging
// ---------------------------------------------------------------------------
const NATIVE_LOGGER_HOST = 'com.bravefox.redirect_logger';
const NATIVE_LOG_SOURCE = 'BraveFox Focus Master (BFFM)';
const NATIVE_LOG_SOURCE_CODE = 'BFFM';
const recentNativeLogKeys = new Map();
let nativeBrowserInfoPromise = null;

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

function parseChromiumBrowserInfo() {
  if (!nativeBrowserInfoPromise) {
    nativeBrowserInfoPromise = (async () => {
      const ua = String(globalThis.navigator?.userAgent || '');
      let browserName = 'Chrome';
      let browserVersion = '';

      const edge = /Edg\/([\d.]+)/i.exec(ua);
      const opera = /(?:OPR|Opera)\/([\d.]+)/i.exec(ua);
      const vivaldi = /Vivaldi\/([\d.]+)/i.exec(ua);
      const chrome = /(?:Chrome|CriOS)\/([\d.]+)/i.exec(ua);

      if (edge) {
        browserName = 'Edge';
        browserVersion = edge[1];
      } else if (opera) {
        browserName = 'Opera';
        browserVersion = opera[1];
      } else if (vivaldi) {
        browserName = 'Vivaldi';
        browserVersion = vivaldi[1];
      } else if (chrome) {
        browserVersion = chrome[1];
        try {
          if (globalThis.navigator?.brave?.isBrave && await globalThis.navigator.brave.isBrave()) {
            browserName = 'Brave';
          }
        } catch {}
      }

      return {
        browserName,
        browserVersion,
        browserEdition: '',
        browserBuildId: '',
        browserPlatform: 'desktop'
      };
    })();
  }
  return nativeBrowserInfoPromise;
}

async function sendNativeBlockLog(reason, sourceUrl, redirectTarget = '') {
  if (!reason || typeof browser.runtime?.sendNativeMessage !== 'function') return;

  const blockedWord = cleanNativeLogText(reason.trigger, 240);
  const attemptedSearch = highlightNativeLogSearch(reason.attemptedSearch, blockedWord);
  const pageUrl = cleanNativeLogText(sourceUrl, 1000);
  const key = `${reason.type || ''}::${blockedWord}::${attemptedSearch}::${pageUrl}`;

  pruneNativeLogKeys();
  if (recentNativeLogKeys.has(key)) return;
  recentNativeLogKeys.set(key, Date.now());

  const browserInfo = await parseChromiumBrowserInfo();
  const manifest = browser.runtime.getManifest();
  const payload = {
    type: 'BRAVEFOX_REDIRECT_LOG',
    source: NATIVE_LOG_SOURCE,
    sourceCode: NATIVE_LOG_SOURCE_CODE,
    extensionName: manifest.name || '',
    extensionVersion: manifest.version || '',
    reasonType: reason.type || (blockedWord ? 'term' : 'unknown'),
    reasonDetail: reason.type === 'link' ? 'Focus Master blocked-link matcher' : 'Focus Master blocked-term matcher',
    blockedWord,
    attemptedSearch,
    context: reason.type === 'link' ? 'blocked-link' : 'blocked-term',
    pageUrl,
    referrer: cleanNativeLogText(redirectTarget, 1000),
    timestamp: new Date().toISOString(),
    ...browserInfo
  };

  try {
    browser.runtime.sendNativeMessage(NATIVE_LOGGER_HOST, payload, () => {
      void browser.runtime.lastError;
    });
  } catch {}
}


function senderUrl(sender) { return String(sender?.url || sender?.tab?.url || ''); }
function senderTabId(sender) { return Number.isInteger(sender?.tab?.id) ? sender.tab.id : null; }
function senderIsInternalPage(sender, pathname) {
  try {
    const url = new URL(senderUrl(sender));
    return sender?.id === browser.runtime.id && url.origin === EXTENSION_ORIGIN && url.pathname === pathname;
  } catch { return false; }
}
function senderIsManager(sender) { return senderIsInternalPage(sender, '/blocker/manager.html'); }
function senderIsOptionsPage(sender) { return senderIsInternalPage(sender, '/blocker/options.html'); }
function senderIsLauncher(sender) {
  return senderIsInternalPage(sender, '/blocker/popup.html') ||
    senderIsInternalPage(sender, '/blocker/options.html');
}
function senderIsPasswordPage(sender, target) {
  try {
    const url = new URL(senderUrl(sender));
    return sender?.id === browser.runtime.id && url.origin === EXTENSION_ORIGIN &&
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
    storageStatus: publicStorageStatus(dataset),
    githubSync: await getGitHubSyncStatus()
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

  if (operation === 'add' || operation === 'remove') {
    await queueRemoteOperation(kind, operation, payload.value);
  } else if (operation === 'merge') {
    const currentSet = new Set(current.map(normalizer));
    for (const value of next) {
      if (!currentSet.has(normalizer(value))) await queueRemoteOperation(kind, 'add', value);
    }
  } else if (operation === 'replace') {
    await queueRemoteSnapshot(kind);
  }

  return {
    ok: true,
    changed: true,
    terms: saved.terms,
    links: saved.links,
    storageStatus: publicStorageStatus(saved),
    githubSync: await getGitHubSyncStatus()
  };
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
  return browser.runtime.getURL(`blocker/blocked.html?${params.toString()}`);
}

async function evaluateNavigation(tabId, url, title = '') {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  if (!isSupportedWebUrl(url) || isCompletelyExcludedUrl(url)) return;
  if (shouldBypassRedirect(tabId, url) || redirectInFlight.has(tabId)) return;
  const last = recentlyRedirected.get(tabId);
  if (last && last.url === url && Date.now() - last.at < 1500) return;

  const [dataset, settings, blockedHost] = await Promise.all([
    loadDataset(),
    getSettings(),
    findBlockedHost(url)
  ]);
  const reason = blockedHost
    ? { type: 'link', trigger: blockedHost, attemptedSearch: '' }
    : findBlockReason({ url, title }, dataset, settings);
  if (!reason) return;

  redirectInFlight.add(tabId);
  recentlyRedirected.set(tabId, { url, at: Date.now() });
  try {
    const directTarget = configuredRedirectTarget(reason, settings, url);
    sendNativeBlockLog(reason, url, directTarget);
    if (directTarget) {
      redirectLandingBypass.set(tabId, { url: directTarget, expiresAt: Date.now() + 15_000 });
      await browser.tabs.update(tabId, { url: directTarget });
    } else {
      await browser.tabs.update(tabId, { url: blockedPageUrl(reason, url) });
    }
    try { await browser.history.deleteUrl({ url }); } catch {}
  } catch (error) {
    console.warn('[BraveFox Focus Master] Redirect failed:', error);
  } finally {
    redirectInFlight.delete(tabId);
  }
}

async function authenticatePopupAndOpen(message, sender) {
  if (!senderIsLauncher(sender)) throw new Error('Focus Master launcher request denied.');
  if (isIncognitoSender(sender)) throw new Error('Management is unavailable in Incognito.');
  if (!(await verifyPassword(message.password))) return { ok: true, unlocked: false };

  const tab = await browser.tabs.create({ url: 'about:blank', active: true });
  if (!Number.isInteger(tab.id)) throw new Error('Could not create the manager tab.');
  try {
    await registerManagerTab(tab.id);
    await establishManagerSession(tab.id);
    await browser.tabs.update(tab.id, { url: browser.runtime.getURL('blocker/manager.html') });
  } catch (error) {
    await browser.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
  return { ok: true, unlocked: true };
}

browser.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId !== 0) return;
  void evaluateNavigation(details.tabId, details.url, '');
});
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || '';
  const title = changeInfo.title || tab.title || '';
  if (url) void evaluateNavigation(tabId, url, title);
});
browser.tabs.onRemoved.addListener(tabId => {
  recentlyRedirected.delete(tabId);
  redirectInFlight.delete(tabId);
  redirectLandingBypass.delete(tabId);
  void cleanupTabAuth(tabId);
});
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes[STORAGE_KEYS.datasetMeta] || Object.keys(changes).some(key => key.startsWith('bfb:data:'))) {
      invalidateDatasetCache();
      void loadDataset({ force: true }).catch(() => {});
    }
  } else if (areaName === 'local' && changes[STORAGE_KEYS.localDataset]) invalidateDatasetCache();
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      case MESSAGE.quickAddItem: {
        if (!senderIsOptionsPage(sender)) throw new Error('Quick Block request denied.');
        if (isIncognitoSender(sender)) throw new Error('Quick Block is unavailable in private browsing.');
        const kind = message.kind === 'links' ? 'links' : message.kind === 'terms' ? 'terms' : '';
        if (!kind) throw new Error('Choose Add Term or Add Link first.');
        const normalizer = kind === 'links' ? normalizeLinkForStorage : normalizeTerm;
        const value = normalizer(message.value);
        if (!value) throw new Error(kind === 'links' ? 'Enter a valid link.' : 'Enter a valid term.');
        const result = await mutateDataset(kind, 'add', { value });
        const values = kind === 'links' ? result.links : result.terms;
        return {
          ok: true,
          changed: Boolean(result.changed),
          kind,
          value,
          count: values.length,
          storageStatus: result.storageStatus,
          githubSync: result.githubSync
        };
      }
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
        await Promise.all([queueRemoteSnapshot('terms'), queueRemoteSnapshot('links')]);
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
      case MESSAGE.getGitHubSyncStatus:
        await requireManagerAccess(sender);
        return { ok: true, githubSync: await getGitHubSyncStatus() };
      case MESSAGE.saveGitHubSyncConfig:
        await requireManagerAccess(sender);
        return {
          ok: true,
          githubSync: await saveGitHubSyncConfig({
            autoSync: message.autoSync,
            tokenRecovery: message.tokenRecovery,
            interactiveRecovery: Boolean(message.interactiveRecovery),
            token: message.token,
            clearToken: Boolean(message.clearToken),
            activeProfile: message.activeProfile,
            confirmProfileSwitch: Boolean(message.confirmProfileSwitch),
            profileExplicit: Boolean(message.profileExplicit)
          })
        };
      case MESSAGE.downloadGitHubLists: {
        await requireManagerAccess(sender);
        const result = await downloadGitHubLists({ allowBundledFallback: true });
        return {
          ok: true,
          terms: result.dataset.terms,
          links: result.dataset.links,
          storageStatus: publicStorageStatus(result.dataset),
          githubSync: await getGitHubSyncStatus(),
          usedBundledFallback: Boolean(result.usedBundledFallback)
        };
      }
      case MESSAGE.uploadGitHubLists: {
        await requireManagerAccess(sender);
        const result = await uploadGitHubLists();
        return {
          ok: true,
          terms: result.dataset.terms,
          links: result.dataset.links,
          storageStatus: publicStorageStatus(result.dataset),
          githubSync: await getGitHubSyncStatus()
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

try {
  const accessLevelResult = browser.storage.sync?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (accessLevelResult?.catch) void accessLevelResult.catch(() => {});
} catch {}
try {
  const removeAuthResult = browser.storage.sync?.remove?.(STORAGE_KEYS.auth);
  if (removeAuthResult?.catch) void removeAuthResult.catch(() => {});
} catch {}
void (async () => {
  try {
    await initializeTrustedSites();
    await initializeGitHubSync();
    await loadDataset({ force: true });
  } catch (error) {
    console.warn('[BraveFox Focus Master] Startup initialization failed:', error);
  }
})();
void initializeHosts().catch(error => console.warn('[BraveFox Focus Master] Hosts initialization failed:', error));
console.log(`[BraveFox Focus Master] Module ${BLOCKER_VERSION} initialized with local lists, browser profile mirroring, cross-browser GitHub sync, and bundled fallbacks.`);
