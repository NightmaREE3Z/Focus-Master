import { browser } from './blocker/api.js';
import { BLOCKER_VERSION, MESSAGE, STORAGE_KEYS } from './blocker/constants.js';
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
} from './blocker/auth.js';
import { findBlockReason, hasScopedLinkRulesForUrl } from './blocker/matcher.js';
import { findTimeRuleBlock, initializeTimeRuleTracking, sampleTimeRuleUsageNow } from './blocker/timers.js';
import { expandWrappedWebUrls, extractWrappedTargetUrls, isUnsupportedArchiveUrl } from './blocker/url-wrappers.js';
import { refreshTimeRulePrepaintRegistration } from './blocker/time-rule-prepaint-registration.js';
import { findBlockedHost, initializeHosts } from './blocker/hosts.js';
import {
  downloadGitHubLists,
  getGitHubSyncStatus,
  initializeGitHubSync,
  queueRemoteOperation,
  queueRemoteSnapshot,
  saveGitHubSyncConfig,
  SYNC_PROFILES,
  uploadGitHubLists
} from './blocker/github-sync.js';
import {
  getSettings,
  invalidateDatasetCache,
  loadDataset,
  saveDataset,
  synchronizeNow,
  updateSettings
} from './blocker/storage.js';
import { normalizeTrustedSiteEntry } from './blocker/trusted-sites.js';
import {
  isCompletelyExcludedUrl,
  isIncognitoSender,
  isSupportedWebUrl,
  normalizeLinkForStorage,
  normalizeTerm,
  normalizeTldForStorage,
  uniqueInOrder
} from './blocker/shared.js';

// ---------------------------------------------------------------------------
// Immutable hardcoded link enforcement
// ---------------------------------------------------------------------------
// These rules are compiled directly into background.js in addition to
// blocker/lists/blockedLinks.csv. Removing a matching row from the physical,
// synchronized or imported CSV does not remove this enforcement layer.
// TrustedSites.csv remains the explicit allow-list and is evaluated first.
const HARD_CODED_LINKS = Object.freeze(
[
  "theredtool.com",
  "lightxeditor.com",
  "picwish.com",
  "snapedit.app",
  "snapedit.ai",
  "twitter.com",
  "x.com",
  "ask.fm",
  "tiktokcelebrities.com",
  "photocut.ai",
  "tiktokus.info",
  "aitoolfor.org",
  "reddit.com/r/BayleyBooty",
  "xvideos.com/c/AI-239",
  "xvideos.com?k=3d",
  "xvideos.com?k=WWE",
  "xvideos.com?k=TNA",
  "xvideos.com?k=AEW",
  "deepnude.to",
  "nudify.me",
  "deepnudeai.org",
  "onlyfans.com",
  "justforfans.com",
  "fanso.io",
  "okfans.com",
  "sourceforge.net/projects/dreamtime.mirror",
  "reddit.com/r/extramile",
  "wrestlingffp.forumcommunity.net",
  "xvideos.com?k=3d&top",
  "xvideos.com?k=Stephanie+McMahon",
  "redtube.com",
  "remove.bg",
  "removex.io",
  "removebg.club",
  "reddit.com/r/GeniusOfTheSky",
  "starryai.com",
  "undressher.app",
  "nudifyonline.tech",
  "vanice.ai",
  "venice.ai",
  "vanice-ai.com",
  "venice-ai.com",
  "venice-ai.net",
  "venice-ai.org",
  "vanice-ai.org",
  "thesmackdownhotel.com/wrestlers/red-velvet",
  "thesmackdownhotel.com/wrestlers/riho",
  "thesmackdownhotel.com/wrestlers/ava-raine",
  "thesmackdownhotel.com/wrestlers/delta",
  "arxiv.org",
  "ira-amanda.blogspot.com",
  "ira-amanda.blogspot.fi",
  "irpp4.blogspot.com",
  "irpp4.blogspot.fi",
  "perttas.blogspot.com",
  "perttas.blogspot.fi",
  "jiujau.blogspot.com",
  "jiujau.blogspot.fi",
  "multicorewareinc.com",
  "gemini.google.com",
  "user/3ws1lu2bwli971gvhv28yemrm",
  "instagram.com/taijamaarit",
  "instagram.com/emiliaaq96",
  "upskirt.tv",
  "celeb.gate.cc",
  "pullpush.io",
  "search.pullpush.io",
  "search.yahoo.com",
  "duckduckgo.com",
  "celebgate.cc",
  "bing.com",
  "nubee.ai",
  "tiktokwood.com",
  "tiktok-for-business.co.jp",
  "arvin.chat",
  "xvideos.com?k=Tegan+Nox",
  "insmind.com",
  "picwish.ai",
  "xvideos.com?k=Liv+Morgan",
  "xvideos.com?k=Steph+McMahon",
  "web.archive.org/web/20230913153255",
  "microsoft.com/fi-fi/edge",
  "explore.microsoft.com/fi-fi/edge",
  "explore.microsoft.com/en-us/edge/download?form=MA14LQ&cs=3404660611",
  "explore.microsoft.com"
]
);

const recentlyRedirected = new Map();
const redirectInFlight = new Set();
const redirectLandingBypass = new Map();
const EXTENSION_ORIGIN = new URL(browser.runtime.getURL('/')).origin;
const HARD_CODED_LINK_RULES = uniqueInOrder(HARD_CODED_LINKS, normalizeLinkForStorage);


// The master Enabled toggle is intentionally a normal-window control only.
// Focus Master uses manifest "incognito": "split", so the Incognito service
// worker has its own execution context even though extension storage is shared.
// In that Incognito context, the master blocker is always treated as enabled.
function getEffectiveEnforcementSettings(settings) {
  if (!chrome.extension?.inIncognitoContext) return settings;
  return {
    ...settings,
    enabled: true
  };
}

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
  const reasonType = reason.type || (blockedWord ? 'term' : 'unknown');
  const reasonDetail = reasonType === 'host'
    ? 'Focus Master fetched-hosts matcher'
    : reasonType === 'link'
      ? 'Focus Master blocked-link matcher'
      : reasonType === 'tld'
        ? 'Focus Master blocked-TLD matcher'
        : reasonType === 'schedule'
          ? 'Focus Master scheduled block'
          : reasonType === 'quota'
            ? 'Focus Master daily time limit'
            : 'Focus Master blocked-term matcher';
  const context = reasonType === 'host'
    ? 'fetched-host'
    : reasonType === 'link'
      ? 'blocked-link'
      : reasonType === 'tld'
        ? 'blocked-tld'
        : reasonType === 'schedule'
          ? 'scheduled-block'
          : reasonType === 'quota'
            ? 'daily-limit'
            : 'blocked-term';
  const payload = {
    type: 'BRAVEFOX_REDIRECT_LOG',
    source: NATIVE_LOG_SOURCE,
    sourceCode: NATIVE_LOG_SOURCE_CODE,
    extensionName: manifest.name || '',
    extensionVersion: manifest.version || '',
    reasonType,
    reasonDetail,
    blockedWord,
    attemptedSearch,
    context,
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

function publicCounts(dataset) { return { termCount: dataset.terms.length, linkCount: dataset.links.length, tldCount: dataset.tlds.length, trustedSiteCount: dataset.trustedSites.length }; }

function consoleClockTime() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function logLoadedBlocklists(dataset) {
  const profile = SYNC_PROFILES?.[dataset?.profile] || null;
  const profileLabel = profile?.label || dataset?.profile || 'Unknown';
  const termsFile = profile?.termsFile || 'blockedTerms.csv';
  const termCount = Array.isArray(dataset?.terms) ? dataset.terms.length : 0;
  const linkCount = Array.isArray(dataset?.links) ? dataset.links.length : 0;
  const tldCount = Array.isArray(dataset?.tlds) ? dataset.tlds.length : 0;
  const trustedCount = Array.isArray(dataset?.trustedSites) ? dataset.trustedSites.length : 0;
  console.log(
    `[${consoleClockTime()}] Focus Master lists loaded: ${termsFile} (${termCount} terms), ` +
    `blockedLinks.csv (${linkCount} links + ${HARD_CODED_LINK_RULES.length} immutable), blockedTLDs.csv (${tldCount} TLDs), ` +
    `TrustedSites.csv (${trustedCount} trusted rules) — profile ${profileLabel}`
  );
}
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
    tlds: dataset.tlds,
    trustedSites: dataset.trustedSites,
    profile: dataset.profile,
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
    'redirectTerms', 'redirectTermsUrl', 'redirectLinks', 'redirectLinksUrl',
    'scheduledRules', 'quotaRules'
  ]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = source[key];
  }
  output.lockManager = true;
  return output;
}

function normalizerForKind(kind) {
  if (kind === 'links') return normalizeLinkForStorage;
  if (kind === 'tlds') return normalizeTldForStorage;
  if (kind === 'trustedSites') return normalizeTrustedSiteEntry;
  if (kind === 'terms') return normalizeTerm;
  throw new Error('Unknown list type.');
}

async function mutateDataset(kind, operation, payload) {
  const normalizer = normalizerForKind(kind);
  const dataset = await loadDataset({ force: true });
  const current = Array.isArray(dataset[kind]) ? dataset[kind] : [];
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
    links: kind === 'links' ? next : dataset.links,
    tlds: kind === 'tlds' ? next : dataset.tlds,
    trustedSites: kind === 'trustedSites' ? next : dataset.trustedSites,
    profile: dataset.profile
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
    tlds: saved.tlds,
    trustedSites: saved.trustedSites,
    profile: saved.profile,
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
  if ((reason?.type === 'link' || reason?.type === 'tld') && settings?.redirectLinks) configured = settings.redirectLinksUrl;
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
  if (reason?.type === 'schedule' && reason?.rule?.endTime) {
    params.set('until', reason.rule.endTime);
  }
  return browser.runtime.getURL(`blocker/blocked.html?${params.toString()}`);
}

async function prepaintTimeRuleCheck(message, sender) {
  const tabId = sender?.tab?.id;
  const url = String(message?.url || '').trim();
  if (!Number.isInteger(tabId) || tabId < 0 || !isSupportedWebUrl(url)) {
    return { ok: true, blocked: false };
  }

  const [dataset, storedSettings] = await Promise.all([
    loadDataset(),
    getSettings()
  ]);
  const settings = getEffectiveEnforcementSettings(storedSettings);
  const reason = await findTimeRuleBlock(url, settings, dataset.profile);
  if (!reason) return { ok: true, blocked: false };

  // The document_start content script has already hidden the destination, so
  // replacing the tab here produces no visible flash of the blocked site.
  redirectInFlight.add(tabId);
  recentlyRedirected.set(tabId, { url, at: Date.now() });
  try {
    sendNativeBlockLog(reason, url, '');
    await browser.tabs.update(tabId, { url: blockedPageUrl(reason, url) });
    try { await browser.history.deleteUrl({ url }); } catch {}
    return { ok: true, blocked: true };
  } catch (error) {
    console.warn('[BraveFox Focus Master] Time Rule pre-paint redirect failed:', error);
    return { ok: false, blocked: false, error: String(error?.message || error) };
  } finally {
    redirectInFlight.delete(tabId);
  }
}

function isTwitchUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return host === 'twitch.tv' || host.endsWith('.twitch.tv');
  } catch {
    return false;
  }
}

async function evaluateNavigation(tabId, url, title = '') {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  if (isTwitchUrl(url)) return;
  if (!isSupportedWebUrl(url)) return;
  if (shouldBypassRedirect(tabId, url) || redirectInFlight.has(tabId)) return;
  const last = recentlyRedirected.get(tabId);
  if (last && last.url === url && Date.now() - last.at < 1500) return;

  // Trusted sites now live in the same synchronized dataset as the other
  // Focus Master rules. Loading the dataset first also applies the current
  // trusted-domain/path snapshot before any blocking decision is made.
  const [dataset, storedSettings] = await Promise.all([
    loadDataset(),
    getSettings()
  ]);
  const settings = getEffectiveEnforcementSettings(storedSettings);

  // Priority 1A: unsupported archive services are an unconditional hard denial.
  // Opaque snapshot IDs can hide the original destination, so allowing these
  // hosts would create a bypass around blocked links/hosts.
  if (isUnsupportedArchiveUrl(url)) {
    const unsupportedReason = {
      type: 'unsupported',
      trigger: (() => {
        try { return new URL(url).hostname.toLocaleLowerCase('en-US'); } catch { return 'archive'; }
      })(),
      attemptedSearch: ''
    };

    redirectInFlight.add(tabId);
    recentlyRedirected.set(tabId, { url, at: Date.now() });
    try {
      sendNativeBlockLog(unsupportedReason, url, '');
      await browser.tabs.update(tabId, { url: blockedPageUrl(unsupportedReason, url) });
      try { await browser.history.deleteUrl({ url }); } catch {}
    } catch (error) {
      console.warn('[BraveFox Focus Master] Unsupported archive redirect failed:', error);
    } finally {
      redirectInFlight.delete(tabId);
    }
    return;
  }

  // Priority 1B: immutable built-in link rules are the hard-denied link floor.
  // They are compiled into Focus Master, independent of blockedLinks.csv, and
  // intentionally outrank both Time Rules and Trusted Sites. They still follow
  // the master/link-blocking switches, just like the immutable floor did before.
  const hardDeniedDataset = {
    ...dataset,
    terms: [],
    tlds: [],
    links: HARD_CODED_LINK_RULES
  };
  const hardDeniedReason = findBlockReason({ url, title }, hardDeniedDataset, settings);
  if (hardDeniedReason) {
    redirectInFlight.add(tabId);
    recentlyRedirected.set(tabId, { url, at: Date.now() });
    try {
      const directTarget = configuredRedirectTarget(hardDeniedReason, settings, url);
      sendNativeBlockLog(hardDeniedReason, url, directTarget);
      if (directTarget) {
        redirectLandingBypass.set(tabId, { url: directTarget, expiresAt: Date.now() + 15_000 });
        await browser.tabs.update(tabId, { url: directTarget });
      } else {
        await browser.tabs.update(tabId, { url: blockedPageUrl(hardDeniedReason, url) });
      }
      try { await browser.history.deleteUrl({ url }); } catch {}
    } catch (error) {
      console.warn('[BraveFox Focus Master] Hard-denied redirect failed:', error);
    } finally {
      redirectInFlight.delete(tabId);
    }
    return;
  }

  // Priority 2: Time Rules.
  // Scheduled blocks and Daily usage limits are equal-priority restrictions.
  // Either one blocks the page before Trusted Sites is considered. If both are
  // active simultaneously, findTimeRuleBlock() returns the schedule only so the
  // blocked page can show the more useful "blocked until HH:MM" message.
  const timeReason = await findTimeRuleBlock(url, settings, dataset.profile);
  if (timeReason) {
    redirectInFlight.add(tabId);
    recentlyRedirected.set(tabId, { url, at: Date.now() });
    try {
      sendNativeBlockLog(timeReason, url, '');
      await browser.tabs.update(tabId, { url: blockedPageUrl(timeReason, url) });
      try { await browser.history.deleteUrl({ url }); } catch {}
    } catch (error) {
      console.warn('[BraveFox Focus Master] Time-rule redirect failed:', error);
    } finally {
      redirectInFlight.delete(tabId);
    }
    return;
  }

  // Priority 3: TrustedSites.csv is an allow-list for the normal blocker only.
  // It cannot bypass hard-denied built-ins, schedules, or Daily usage limits.
  // Archive/proxy wrappers also cannot launder a blocked destination merely
  // because the wrapper itself is trusted.
  const wrappedTargets = extractWrappedTargetUrls(url);
  if (wrappedTargets.length) {
    if (wrappedTargets.every(target => isCompletelyExcludedUrl(target))) return;
  } else if (isCompletelyExcludedUrl(url)) {
    return;
  }

  // Priority 4A: normal user-managed Blocker terms / links / TLDs.
  // The immutable built-in link floor has already been enforced at Priority 1B,
  // so the normal matcher uses only the synchronized/user-managed dataset here.
  const effectiveDataset = {
    ...dataset,
    links: uniqueInOrder([...HARD_CODED_LINK_RULES, ...dataset.links], normalizeLinkForStorage)
  };
  const reason = findBlockReason({ url, title }, dataset, settings);
  if (reason) {
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
    return;
  }

  // Priority 4B: fetched hosts are the blunt normal-blocker fallback. Archive/proxy URLs are
  // checked against both the wrapper and every deterministic unwrapped target.
  // Path/query-specific Blocker rules keep their surgical-control exemption on
  // the corresponding candidate host instead of globally disabling host checks.
  let blockedHost = '';
  for (const candidateUrl of expandWrappedWebUrls(url)) {
    if (settings.enabled && settings.blockLinks && hasScopedLinkRulesForUrl(candidateUrl, effectiveDataset.links)) continue;
    blockedHost = await findBlockedHost(candidateUrl);
    if (blockedHost) break;
  }
  if (!blockedHost) return;

  const hostReason = { type: 'host', trigger: blockedHost, attemptedSearch: '' };
  redirectInFlight.add(tabId);
  recentlyRedirected.set(tabId, { url, at: Date.now() });
  try {
    sendNativeBlockLog(hostReason, url, '');
    try { await browser.history.deleteUrl({ url }); } catch {}
    await browser.tabs.remove(tabId);
  } catch (error) {
    console.warn('[BraveFox Focus Master] Fetched-host tab close failed:', error);
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
try {
  browser.webNavigation.onHistoryStateUpdated.addListener(details => {
    if (details.frameId !== 0) return;
    void evaluateNavigation(details.tabId, details.url, '');
  });
} catch {}
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const urlChanged = typeof changeInfo.url === 'string' && Boolean(changeInfo.url);
  const titleChanged = typeof changeInfo.title === 'string';

  // Ignore unrelated tab updates. More importantly, never pair a freshly
  // changed URL with tab.title: Chromium can briefly keep the previous page's
  // title there during navigation, which can create a false term match on the
  // destination URL. webNavigation already checks the URL itself, and the
  // destination title is checked when Chrome reports its actual title update.
  if (!urlChanged && !titleChanged) return;

  const url = urlChanged ? changeInfo.url : (tab.url || '');
  const title = !urlChanged && titleChanged ? changeInfo.title : '';
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
  } else if (areaName === 'local' && changes[STORAGE_KEYS.localDataset]) {
    invalidateDatasetCache();
  }

  const timeSettingsChanged =
    (areaName === 'sync' && Boolean(changes[STORAGE_KEYS.settings])) ||
    (areaName === 'local' && Boolean(changes[STORAGE_KEYS.localSettings]));

  if (timeSettingsChanged) {
    void getSettings()
      .then(settings => refreshTimeRulePrepaintRegistration(settings))
      .catch(() => {});
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type || !String(message.type).startsWith('BFB_')) return;
  (async () => {
    switch (message.type) {
      case MESSAGE.timeRulePrepaintCheck:
        return prepaintTimeRuleCheck(message, sender);
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
        const settings = await updateSettings(sanitizeAdminPatch(message.patch));
        void sampleTimeRuleUsageNow();
        return {
          ok: true,
          settings,
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
        const current = await loadDataset({ force: true });
        const saved = await saveDataset({
          terms: message.terms,
          links: message.links,
          tlds: Array.isArray(message.tlds) ? message.tlds : current.tlds,
          trustedSites: Array.isArray(message.trustedSites) ? message.trustedSites : current.trustedSites,
          profile: current.profile
        });
        const snapshots = [queueRemoteSnapshot('terms'), queueRemoteSnapshot('links')];
        if (Array.isArray(message.tlds)) snapshots.push(queueRemoteSnapshot('tlds'));
        if (Array.isArray(message.trustedSites)) snapshots.push(queueRemoteSnapshot('trustedSites'));
        await Promise.all(snapshots);
        const settings = await updateSettings(sanitizeAdminPatch(message.settings));
        return {
          ok: true,
          terms: saved.terms,
          links: saved.links,
          tlds: saved.tlds,
          trustedSites: saved.trustedSites,
          profile: saved.profile,
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
          tlds: result.dataset.tlds,
          trustedSites: result.dataset.trustedSites,
          profile: result.dataset.profile,
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
          tlds: result.dataset.tlds,
          trustedSites: result.dataset.trustedSites,
          profile: result.dataset.profile,
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
          tlds: result.dataset.tlds,
          trustedSites: result.dataset.trustedSites,
          profile: result.dataset.profile,
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
void getSettings()
  .then(settings => refreshTimeRulePrepaintRegistration(settings))
  .catch(error => console.warn('[BraveFox Focus Master] Initial Time Rule pre-paint registration failed:', error));

initializeTimeRuleTracking({
  getContext: async () => {
    const [settings, dataset] = await Promise.all([getSettings(), loadDataset()]);
    return { settings: getEffectiveEnforcementSettings(settings), profile: dataset.profile };
  },
  onActiveTabSample: async (tabId, url) => {
    await evaluateNavigation(tabId, url, '');
  }
});

void (async () => {
  try {
    await initializeTrustedSites();
    await initializeGitHubSync();
    const dataset = await loadDataset({ force: true });
    logLoadedBlocklists(dataset);
  } catch (error) {
    console.warn('[BraveFox Focus Master] Startup initialization failed:', error);
  }
})();
void initializeHosts().catch(error => console.warn('[BraveFox Focus Master] Hosts initialization failed:', error));
const startupVersion = browser.runtime.getManifest().version;
console.log(`[${consoleClockTime()}] BraveFox Focus Master ${startupVersion} initialized`);
