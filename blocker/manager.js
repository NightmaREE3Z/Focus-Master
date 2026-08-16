import { browser } from './api.js';
import { MESSAGE } from './constants.js';
import {
  parseFullBackup,
  parseListText,
  serializeFullBackup,
  serializeListCsv,
  serializeListForKind
} from './csv.js';
import {
  downloadText,
  normalizeLinkForStorage,
  normalizeRedirectUrl,
  normalizeTerm,
  normalizeTldForStorage
} from './shared.js';
import { normalizeTrustedSiteEntry, parseTrustedSiteEntry } from './trusted-sites.js';

const state = {
  view: 'terms',
  terms: [],
  links: [],
  tlds: [],
  trustedSites: [],
  trustedSiteFilter: 'domain',
  settings: {},
  storageStatus: {},
  githubSync: null,
  adminUnlocked: false
};

const $ = selector => document.querySelector(selector);
const elements = {};
let toastTimer = null;
let accessTimer = null;
let lockingOut = false;

function isLockError(message) {
  return /BraveFox Focus Master is locked|management request denied|management is unavailable|request denied/i.test(String(message || ''));
}

function openNativePasswordPage() {
  const params = new URLSearchParams({ target: 'blocker-manager' });
  window.location.replace(browser.runtime.getURL(`html/password-protected.html?${params.toString()}`));
}

function openPopupRequiredPage() {
  window.location.replace(browser.runtime.getURL('blocker/popup-required.html'));
}

function secureLockout(registered = true) {
  if (lockingOut) return;
  lockingOut = true;
  if (accessTimer) clearInterval(accessTimer);
  document.body.replaceChildren();
  if (registered) openNativePasswordPage();
  else openPopupRequiredPage();
}

async function message(payload, { redirectOnLock = true } = {}) {
  try {
    const response = await browser.runtime.sendMessage(payload);
    if (!response?.ok) {
      const errorText = response?.error || 'BraveFox Focus Master request failed.';
      if (redirectOnLock && isLockError(errorText)) secureLockout(true);
      throw new Error(errorText);
    }
    return response;
  } catch (error) {
    const errorText = String(error?.message || error || 'BraveFox Focus Master request failed.');
    if (redirectOnLock && isLockError(errorText)) secureLockout(true);
    throw new Error(errorText);
  }
}

function toast(text) {
  if (!elements.toast) return;
  elements.toast.textContent = text;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast?.classList.remove('show'), 2600);
}

function valuesForKind(kind) {
  return Array.isArray(state[kind]) ? state[kind] : [];
}

function currentSingleKind() {
  return state.view === 'trustedSites' ? 'trustedSites' : 'terms';
}

function normalizerForKind(kind) {
  if (kind === 'links') return normalizeLinkForStorage;
  if (kind === 'tlds') return normalizeTldForStorage;
  if (kind === 'trustedSites') return normalizeTrustedSiteEntry;
  return normalizeTerm;
}

function kindLabel(kind, count = 1) {
  const plural = count === 1 ? '' : 's';
  if (kind === 'links') return `link${plural}`;
  if (kind === 'tlds') return `TLD${plural}`;
  if (kind === 'trustedSites') return `trusted site rule${plural}`;
  return `term${plural}`;
}

function exportNameForKind(kind) {
  if (kind === 'links') return 'BraveFox-Blocker-Links.csv';
  if (kind === 'tlds') return 'BraveFox-Blocker-TLDs.csv';
  if (kind === 'trustedSites') return 'BraveFox-TrustedSites.csv';
  return 'BraveFox-Blocker-Terms.csv';
}

function displayEntry(kind, value) {
  if (kind !== 'trustedSites') return { text: value, badge: kind === 'links' ? 'LINK' : kind === 'tlds' ? 'TLD' : '', badgeClass: kind };
  const descriptor = parseTrustedSiteEntry(value);
  if (!descriptor) return { text: value, badge: 'RULE', badgeClass: 'domain' };
  return {
    text: descriptor.type === 'path' ? `${descriptor.host}${descriptor.pathPrefix}` : descriptor.host,
    badge: descriptor.type.toUpperCase(),
    badgeClass: descriptor.type,
    title: descriptor.type === 'domain'
      ? 'Trusted domain: includes this domain and all subdomains.'
      : 'Trusted path: exact host plus this path tree.'
  };
}

function applyResponse(response) {
  if (Array.isArray(response.terms)) state.terms = response.terms;
  if (Array.isArray(response.links)) state.links = response.links;
  if (Array.isArray(response.tlds)) state.tlds = response.tlds;
  if (Array.isArray(response.trustedSites)) state.trustedSites = response.trustedSites;
  if (response.settings && typeof response.settings === 'object') state.settings = response.settings;
  if (response.storageStatus && typeof response.storageStatus === 'object') state.storageStatus = response.storageStatus;
  if (response.githubSync && typeof response.githubSync === 'object') state.githubSync = response.githubSync;
  if (typeof response.adminUnlocked === 'boolean') state.adminUnlocked = response.adminUnlocked;
  renderStorageStatus();
}

function renderStorageStatus() {
  if (!elements.syncLabel) return;
  const github = state.githubSync;
  if (github?.pendingCount) {
    elements.syncLabel.textContent = `${github.pendingCount} GitHub change${github.pendingCount === 1 ? '' : 's'} pending`;
    elements.syncLabel.title = github.lastError || 'Automatic sync will retry shortly.';
    return;
  }
  if (github?.lastError) {
    elements.syncLabel.textContent = 'GitHub sync failed — local lists active';
    elements.syncLabel.title = github.lastError;
    return;
  }
  if (github?.lastSyncAt) {
    elements.syncLabel.textContent = 'Local + GitHub lists synchronized';
    elements.syncLabel.title = `${github.lastAction || 'GitHub sync'} — ${new Date(github.lastSyncAt).toLocaleString()}`;
    return;
  }
  if (state.storageStatus?.syncPending) {
    elements.syncLabel.textContent = 'Saved locally — browser profile mirror pending';
    elements.syncLabel.title = state.storageStatus.syncError || 'The browser will retry its profile mirror.';
  } else {
    elements.syncLabel.textContent = 'Local lists active — GitHub sync available';
    elements.syncLabel.title = 'Open Sync to configure public GitHub list synchronization.';
  }
}

function trustedSiteTypeCounts() {
  const counts = { domain: 0, path: 0 };
  for (const value of state.trustedSites) {
    const descriptor = parseTrustedSiteEntry(value);
    if (descriptor?.type === 'domain' || descriptor?.type === 'path') counts[descriptor.type] += 1;
  }
  return counts;
}

function updateTrustedTypeFilterUi() {
  if (!elements.trustedTypeFilter) return;
  const counts = trustedSiteTypeCounts();
  const selected = state.trustedSiteFilter === 'path' ? 'path' : 'domain';
  state.trustedSiteFilter = selected;
  elements.trustedTypeFilter.value = selected;
  elements.trustedTypeFilter.classList.toggle('domain', selected === 'domain');
  elements.trustedTypeFilter.classList.toggle('path', selected === 'path');
  const domainOption = elements.trustedTypeFilter.querySelector('option[value="domain"]');
  const pathOption = elements.trustedTypeFilter.querySelector('option[value="path"]');
  if (domainOption) domainOption.textContent = `DOMAIN · ${counts.domain}`;
  if (pathOption) pathOption.textContent = `PATH · ${counts.path}`;
  if (elements.searchInput && state.view === 'trustedSites') {
    elements.searchInput.placeholder = selected === 'domain' ? 'Search trusted domains' : 'Search trusted paths';
  }
}

function renderCounts() {
  if (elements.termCount) elements.termCount.textContent = state.terms.length;
  if (elements.linkTldCount) elements.linkTldCount.textContent = state.links.length + state.tlds.length;
  if (elements.trustedSiteCount) elements.trustedSiteCount.textContent = state.trustedSites.length;
  if (elements.linkSectionCount) elements.linkSectionCount.textContent = state.links.length;
  if (elements.tldSectionCount) elements.tldSectionCount.textContent = state.tlds.length;
  updateTrustedTypeFilterUi();
}

async function removeEntry(kind, value) {
  const display = displayEntry(kind, value).text;
  if (!confirm(`Remove “${display}”?`)) return;
  try {
    const response = await message({ type: MESSAGE.removeItem, kind, value });
    applyResponse(response);
    renderCounts();
    renderCurrentView();
    toast('Entry removed; GitHub sync queued.');
  } catch (error) {
    if (!lockingOut) toast(error.message);
  }
}

function makeListRow(kind, value) {
  const row = document.createElement('div');
  row.className = 'item';
  row.setAttribute('role', 'listitem');

  const main = document.createElement('div');
  main.className = 'item-main';
  const display = displayEntry(kind, value);
  if (display.badge) {
    const badge = document.createElement('span');
    badge.className = `item-kind-badge ${display.badgeClass || ''}`.trim();
    badge.textContent = display.badge;
    if (display.title) badge.title = display.title;
    main.appendChild(badge);
  }

  const label = document.createElement('div');
  label.className = 'item-value';
  label.textContent = display.text;
  if (display.title) label.title = display.title;
  main.appendChild(label);

  const remove = document.createElement('button');
  remove.className = 'remove-button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => void removeEntry(kind, value));

  row.append(main, remove);
  return row;
}

function renderListInto(kind, searchElement, itemsElement, emptyElement, predicate = null) {
  if (!searchElement || !itemsElement || !emptyElement) return;
  const search = searchElement.value.trim().toLocaleLowerCase('en-US');
  const values = valuesForKind(kind).filter(value => {
    if (predicate && !predicate(value)) return false;
    if (!search) return true;
    const display = displayEntry(kind, value).text.toLocaleLowerCase('en-US');
    return display.includes(search) || String(value).toLocaleLowerCase('en-US').includes(search);
  });
  itemsElement.replaceChildren();
  emptyElement.hidden = values.length > 0;
  const fragment = document.createDocumentFragment();
  for (const value of values) fragment.appendChild(makeListRow(kind, value));
  itemsElement.appendChild(fragment);
}

function renderSingleList() {
  if (state.view === 'trustedSites') {
    updateTrustedTypeFilterUi();
    const selected = state.trustedSiteFilter;
    elements.emptyState.textContent = selected === 'domain' ? 'No trusted domains yet.' : 'No trusted paths yet.';
    renderListInto('trustedSites', elements.searchInput, elements.items, elements.emptyState, value => parseTrustedSiteEntry(value)?.type === selected);
    return;
  }
  elements.emptyState.textContent = 'No entries yet.';
  renderListInto('terms', elements.searchInput, elements.items, elements.emptyState);
}

function renderSplitLists() {
  renderListInto('links', elements.linkSearchInput, elements.linkItems, elements.linkEmptyState);
  renderListInto('tlds', elements.tldSearchInput, elements.tldItems, elements.tldEmptyState);
}

function renderCurrentView() {
  if (state.view === 'links') renderSplitLists();
  else if (state.view === 'terms' || state.view === 'trustedSites') renderSingleList();
}

function selectView(view) {
  state.view = view;
  for (const button of document.querySelectorAll('.nav-button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }

  const settings = view === 'settings';
  const split = view === 'links';
  const single = view === 'terms' || view === 'trustedSites';
  elements.singleListView.hidden = !single;
  elements.linksTldsView.hidden = !split;
  elements.settingsView.hidden = !settings;
  if (elements.trustedTypeBar) elements.trustedTypeBar.hidden = view !== 'trustedSites';

  if (view === 'terms') {
    elements.viewTitle.textContent = 'Blocked terms';
    elements.viewSubtitle.textContent = 'Manage words and phrases that trigger blocking.';
    elements.addInput.placeholder = 'Add a term or phrase';
    elements.searchInput.placeholder = 'Search the list';
    elements.singleListOrderNote.textContent = 'Order follows the CSV. Merge imports append new unique entries; manual additions go to the end.';
  } else if (view === 'links') {
    elements.viewTitle.textContent = 'Blocked links / TLDs';
    elements.viewSubtitle.textContent = 'Keep exact URL rules separate from hostname-suffix TLD rules.';
  } else if (view === 'trustedSites') {
    elements.viewTitle.textContent = 'Trusted sites';
    elements.viewSubtitle.textContent = 'Allow trusted domains or specific path trees before every blocking layer.';
    elements.addInput.placeholder = 'Add a domain or URL/path to trust';
    updateTrustedTypeFilterUi();
    elements.singleListOrderNote.textContent = 'DOMAIN trusts the domain plus subdomains. PATH trusts only the exact host and that path tree.';
  } else {
    elements.viewTitle.textContent = 'Settings';
    elements.viewSubtitle.textContent = 'Password-protected enforcement controls, synchronization and backups.';
    void renderAdminState();
  }
  renderCurrentView();
}

function getTemplate(id) {
  const template = document.getElementById(id);
  if (!(template instanceof HTMLTemplateElement)) {
    throw new Error(`Missing UI template: ${id}`);
  }
  return template;
}

function loadUiFragment() {
  const app = document.getElementById('app');
  if (!app) throw new Error('Missing manager UI.');
  app.hidden = false;
  document.getElementById('bootScreen')?.remove();
}

function setAdminLockedUi() {
  state.adminUnlocked = false;
  if (!elements.adminControlsMount) return;
  elements.adminControlsMount.replaceChildren();
  elements.adminLocked.hidden = false;
  elements.adminPasswordInput.value = '';
  elements.adminError.textContent = '';
}

function setAdminDependentState() {
  const enabled = Boolean(state.settings.enabled);
  if (elements.enabledToggle) elements.enabledToggle.checked = enabled;
  if (elements.blockTermsToggle) {
    elements.blockTermsToggle.checked = Boolean(state.settings.blockTerms);
    elements.blockTermsToggle.disabled = !enabled;
  }
  if (elements.blockLinksToggle) {
    elements.blockLinksToggle.checked = Boolean(state.settings.blockLinks);
    elements.blockLinksToggle.disabled = !enabled;
  }
  if (elements.ttlSelect) elements.ttlSelect.value = String(state.settings.unlockTtlMinutes || 5);
  if (elements.redirectTermsToggle) elements.redirectTermsToggle.checked = Boolean(state.settings.redirectTerms);
  if (elements.redirectTermsUrlInput) elements.redirectTermsUrlInput.value = String(state.settings.redirectTermsUrl || '');
  if (elements.redirectLinksToggle) elements.redirectLinksToggle.checked = Boolean(state.settings.redirectLinks);
  if (elements.redirectLinksUrlInput) elements.redirectLinksUrlInput.value = String(state.settings.redirectLinksUrl || '');

  elements.adminEnabledOptions?.classList.toggle('is-disabled', !enabled);
  elements.redirectSettings?.classList.toggle('is-disabled', !enabled);

  const termAvailable = enabled && Boolean(state.settings.blockTerms);
  const linkAvailable = enabled && Boolean(state.settings.blockLinks);
  for (const control of [elements.redirectTermsToggle, elements.redirectTermsUrlInput, elements.saveTermRedirectButton, elements.clearTermRedirectButton]) {
    if (control) control.disabled = !termAvailable;
  }
  for (const control of [elements.redirectLinksToggle, elements.redirectLinksUrlInput, elements.saveLinkRedirectButton, elements.clearLinkRedirectButton]) {
    if (control) control.disabled = !linkAvailable;
  }
}

async function renderAdminState() {
  if (!elements.adminControlsMount) return;
  if (!state.adminUnlocked) {
    setAdminLockedUi();
    return;
  }
  if (!elements.adminControlsMount.firstElementChild) {
    const content = getTemplate('adminUiTemplate').content.cloneNode(true);
    elements.adminControlsMount.replaceChildren(content);
    bindAdminControls();
  }
  elements.adminLocked.hidden = true;
  setAdminDependentState();
}

async function saveAdminSettings(patch, successMessage = 'Settings saved.') {
  try {
    const response = await message({ type: MESSAGE.updateAdminSettings, patch }, { redirectOnLock: false });
    applyResponse(response);
    setAdminDependentState();
    toast(successMessage);
    return true;
  } catch (error) {
    if (/settings are locked/i.test(error.message)) setAdminLockedUi();
    if (!lockingOut) toast(error.message);
    return false;
  }
}

function normalizedRedirectOrError(input, enabled) {
  const normalized = normalizeRedirectUrl(input.value);
  if (input.value.trim() && !normalized) throw new Error('Enter a valid HTTP or HTTPS destination.');
  if (enabled && !normalized) throw new Error('Set a destination before enabling this redirect.');
  input.value = normalized;
  return normalized;
}

const GITHUB_DATA_COLLECTION = Object.freeze(['authenticationInfo', 'browsingActivity', 'searchTerms']);

function syncStatusText(sync = state.githubSync) {
  if (!sync) return 'GitHub sync has not been configured yet.';
  const lines = [];
  lines.push(`Sync Profile: ${sync.activeProfileLabel || sync.activeProfile || 'Haukkis'} (${sync.target?.files?.terms?.path?.split('/').pop() || 'blockedTerms.csv'})`);
  if (sync.profileSwitchPending) lines.push(`Profile switch pending: local terms are still ${sync.termsProfileLabel || sync.termsProfile}; use manual Download or Upload to commit the switch.`);
  lines.push(sync.autoSync ? 'Automatic Sync: enabled' : 'Automatic Sync: disabled');
  lines.push(sync.hasToken ? 'GitHub token: saved locally' : 'GitHub token: not saved (downloads still work)');
  if (sync.tokenRecovery) {
    const accountSuffix = sync.recoveryAccountEmail ? ` for ${sync.recoveryAccountEmail}` : '';
    if (sync.recoveryReady) lines.push(sync.recoveredFromGoogleDrive ? `Google Drive recovery: token restored${accountSuffix}` : `Google Drive recovery: backup ready${accountSuffix}`);
    else if (!sync.recoverySupported) lines.push('Google Drive recovery: Chrome OAuth is unavailable');
    else if (!sync.recoveryEligible) lines.push(`Google Drive recovery: blocked — ${sync.recoveryBlockedReason || 'an approved Chrome profile account is required.'}`);
    else if (sync.recoveryError) lines.push(`Google Drive recovery: ${sync.recoveryError}`);
    else if (sync.recoveryAuthorizationRequired || !sync.recoveryAuthorized) lines.push(`Google Drive recovery: authorization required — save the settings to connect${accountSuffix}`);
    else lines.push(`Google Drive recovery: connected, waiting for a saved token${accountSuffix}`);
  } else lines.push('Google Drive recovery: disabled');
  lines.push(`Pending changes: ${Number(sync.pendingCount) || 0}`);
  if (sync.lastSyncAt) lines.push(`Last sync: ${new Date(sync.lastSyncAt).toLocaleString()} — ${sync.lastAction || 'completed'}`);
  else lines.push('Last sync: never');
  lines.push('Global lists: blockedLinks.csv + blockedTLDs.csv + TrustedSites.csv');
  if (sync.suggestedProfileLabel) lines.push(`Detected browser account suggests ${sync.suggestedProfileLabel}.`);
  if (sync.lastError) lines.push(`Last error: ${sync.lastError}`);
  return lines.join('\n');
}

function renderGithubSyncDialogStatus(sync = state.githubSync) {
  if (!elements.githubSyncStatus) return;
  elements.githubSyncStatus.textContent = syncStatusText(sync);
  elements.githubSyncStatus.dataset.state = sync?.lastError ? 'error' : sync?.lastSyncAt ? 'ok' : '';
  renderStorageStatus();
}

async function refreshGithubSyncStatus() {
  const response = await message({ type: MESSAGE.getGitHubSyncStatus });
  applyResponse(response);
  if (elements.automaticSyncToggle) elements.automaticSyncToggle.checked = response.githubSync.autoSync !== false;
  if (elements.tokenRecoveryToggle) elements.tokenRecoveryToggle.checked = response.githubSync.tokenRecovery !== false;
  if (elements.syncProfileSelect) elements.syncProfileSelect.value = response.githubSync.activeProfile || 'haukkis';
  if (elements.detectedProfileStatus) {
    if (response.githubSync.detectedEmail) {
      const suggestion = response.githubSync.suggestedProfileLabel ? ` Suggested profile: ${response.githubSync.suggestedProfileLabel}.` : '';
      elements.detectedProfileStatus.textContent = `Detected Chrome profile account: ${response.githubSync.detectedEmail}.${suggestion}`;
    } else if (response.githubSync.detectionAvailable) {
      elements.detectedProfileStatus.textContent = 'No recognized Chrome profile email was detected. Choose a Sync Profile manually.';
    } else {
      elements.detectedProfileStatus.textContent = 'Automatic email detection is unavailable on this browser; choose a Sync Profile manually.';
    }
  }
  if (elements.githubTokenInput) {
    elements.githubTokenInput.value = '';
    elements.githubTokenInput.placeholder = response.githubSync.hasToken
      ? 'A token is saved — leave blank to keep it'
      : 'Token with repository Contents: read/write';
  }
  const files = response.githubSync.target?.files;
  if (files?.terms?.rawUrl && elements.termsRawLink) elements.termsRawLink.href = files.terms.rawUrl;
  if (files?.links?.rawUrl && elements.linksRawLink) elements.linksRawLink.href = files.links.rawUrl;
  if (files?.tlds?.rawUrl && elements.tldsRawLink) elements.tldsRawLink.href = files.tlds.rawUrl;
  if (files?.trustedSites?.rawUrl && elements.trustedSitesRawLink) elements.trustedSitesRawLink.href = files.trustedSites.rawUrl;
  if (files?.terms?.path && elements.termsRawLink) elements.termsRawLink.textContent = files.terms.path.split('/').pop();
  if (files?.links?.path && elements.linksRawLink) elements.linksRawLink.textContent = files.links.path.split('/').pop();
  if (files?.tlds?.path && elements.tldsRawLink) elements.tldsRawLink.textContent = files.tlds.path.split('/').pop();
  if (files?.trustedSites?.path && elements.trustedSitesRawLink) elements.trustedSitesRawLink.textContent = files.trustedSites.path.split('/').pop();
  renderGithubSyncDialogStatus(response.githubSync);
  return response.githubSync;
}

async function ensureGithubUploadConsent() {
  const manifest = browser.runtime.getManifest();
  const isFirefox = Boolean(manifest?.browser_specific_settings?.gecko);
  if (!isFirefox) return true;
  const permissions = await browser.permissions.getAll();
  const granted = new Set(Array.isArray(permissions.data_collection) ? permissions.data_collection : []);
  if (GITHUB_DATA_COLLECTION.every(item => granted.has(item))) return true;
  if (!Array.isArray(permissions.data_collection)) {
    throw new Error('This Firefox version cannot request the required GitHub data-transmission consent.');
  }
  const accepted = await browser.permissions.request({ data_collection: [...GITHUB_DATA_COLLECTION] });
  if (!accepted) throw new Error('GitHub upload consent was declined. Download-only sync remains available.');
  return true;
}

async function saveGithubSettings({ requireConsent = false } = {}) {
  const token = elements.githubTokenInput.value.trim();
  const hasUsableToken = Boolean(token || state.githubSync?.hasToken);
  if (requireConsent && !hasUsableToken) {
    throw new Error('Enter a fine-grained GitHub token before uploading.');
  }
  if (requireConsent || (hasUsableToken && elements.automaticSyncToggle.checked)) await ensureGithubUploadConsent();
  const requestedProfile = elements.syncProfileSelect?.value || state.githubSync?.activeProfile || 'haukkis';
  const changingProfile = Boolean(state.githubSync?.activeProfile && requestedProfile !== state.githubSync.activeProfile);
  let confirmProfileSwitch = false;
  if (changingProfile) {
    const from = state.githubSync.activeProfileLabel || state.githubSync.activeProfile;
    const selected = state.githubSync.profiles?.find(item => item.id === requestedProfile);
    const to = selected?.label || requestedProfile;
    if (!window.confirm(`Switch Sync Profile from ${from} to ${to}?

The current local terms will NOT be replaced now. Automatic term sync pauses until you manually choose Download from GitHub or Upload to GitHub.`)) {
      elements.syncProfileSelect.value = state.githubSync.activeProfile;
      throw new Error('Sync Profile change cancelled.');
    }
    confirmProfileSwitch = true;
  }
  const response = await message({
    type: MESSAGE.saveGitHubSyncConfig,
    autoSync: elements.automaticSyncToggle.checked,
    tokenRecovery: elements.tokenRecoveryToggle.checked,
    interactiveRecovery: elements.tokenRecoveryToggle.checked,
    token,
    activeProfile: requestedProfile,
    confirmProfileSwitch,
    profileExplicit: true
  });
  applyResponse(response);
  renderGithubSyncDialogStatus(response.githubSync);
  elements.githubTokenInput.value = '';
  elements.githubTokenInput.placeholder = response.githubSync.hasToken
    ? 'A token is saved — leave blank to keep it'
    : 'Token with repository Contents: read/write';
  return response.githubSync;
}

async function openGithubSyncDialog() {
  try {
    await refreshGithubSyncStatus();
    if (!elements.syncDialog.open) elements.syncDialog.showModal();
  } catch (error) {
    if (!lockingOut) toast(error.message);
  }
}

async function runGithubAction(button, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = action === 'upload' ? 'Uploading…' : 'Downloading…';
  try {
    if (action === 'upload') {
      await saveGithubSettings({ requireConsent: true });
    } else if (!window.confirm(`Download ${state.githubSync?.activeProfileLabel || 'the selected profile'} terms plus the global links, TLDs and trusted sites from GitHub and replace the current local lists?`)) {
      return;
    }

    const response = await message({
      type: action === 'upload' ? MESSAGE.uploadGitHubLists : MESSAGE.downloadGitHubLists
    });
    applyResponse(response);
    renderCounts();
    if (state.view !== 'settings') renderCurrentView();
    renderGithubSyncDialogStatus(response.githubSync);
    if (action === 'download' && response.usedBundledFallback) {
      toast('GitHub was unavailable. Packaged fallback lists were loaded.');
    } else {
      toast(action === 'upload' ? 'Focus Master lists uploaded to GitHub.' : 'Focus Master lists downloaded from GitHub.');
    }
  } catch (error) {
    renderGithubSyncDialogStatus({ ...(state.githubSync || {}), lastError: error.message });
    if (!lockingOut) toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function bindSyncOpeners(root = document) {
  root.querySelectorAll('[data-open-sync-dialog]').forEach(button => {
    if (button.dataset.syncBound === 'true') return;
    button.dataset.syncBound = 'true';
    button.addEventListener('click', () => void openGithubSyncDialog());
  });
}

function bindGithubSyncDialog() {
  elements.closeSyncDialog.addEventListener('click', () => elements.syncDialog.close());
  elements.syncDialog.addEventListener('click', event => {
    if (event.target === elements.syncDialog) elements.syncDialog.close();
  });
  elements.saveGithubSyncSettings.addEventListener('click', async () => {
    const original = elements.saveGithubSyncSettings.textContent;
    elements.saveGithubSyncSettings.disabled = true;
    elements.saveGithubSyncSettings.textContent = 'Saving…';
    try {
      const sync = await saveGithubSettings();
      if (sync.tokenRecovery && sync.recoveryReady) toast('GitHub sync settings saved; Google Drive recovery is ready.');
      else if (sync.tokenRecovery && sync.recoveryAuthorizationRequired) toast('Settings saved locally, but Google Drive authorization was not completed.');
      else if (sync.tokenRecovery && sync.recoveryError) toast(`Settings saved locally; recovery error: ${sync.recoveryError}`);
      else toast('GitHub sync settings saved.');
    } catch (error) {
      if (!lockingOut) toast(error.message);
    } finally {
      elements.saveGithubSyncSettings.disabled = false;
      elements.saveGithubSyncSettings.textContent = original;
    }
  });
  elements.clearGithubToken.addEventListener('click', async () => {
    if (!window.confirm('Forget the GitHub token saved locally and delete its Google Drive recovery copy?')) return;
    try {
      const response = await message({
        type: MESSAGE.saveGitHubSyncConfig,
        autoSync: elements.automaticSyncToggle.checked,
        tokenRecovery: elements.tokenRecoveryToggle.checked,
        interactiveRecovery: true,
        clearToken: true
      });
      applyResponse(response);
      renderGithubSyncDialogStatus(response.githubSync);
      elements.githubTokenInput.value = '';
      elements.githubTokenInput.placeholder = 'Token with repository Contents: read/write';
      toast('Saved GitHub token forgotten.');
    } catch (error) { toast(error.message); }
  });
  elements.downloadFromGithub.addEventListener('click', () => void runGithubAction(elements.downloadFromGithub, 'download'));
  elements.uploadToGithub.addEventListener('click', () => void runGithubAction(elements.uploadToGithub, 'upload'));
}

function bindAdminControls() {
  Object.assign(elements, {
    adminControls: $('#adminControls'), enabledToggle: $('#enabledToggle'), adminEnabledOptions: $('#adminEnabledOptions'),
    redirectSettings: $('#redirectSettings'), blockTermsToggle: $('#blockTermsToggle'), blockLinksToggle: $('#blockLinksToggle'), ttlSelect: $('#ttlSelect'),
    redirectTermsToggle: $('#redirectTermsToggle'), redirectTermsUrlInput: $('#redirectTermsUrlInput'),
    saveTermRedirectButton: $('#saveTermRedirectButton'), clearTermRedirectButton: $('#clearTermRedirectButton'),
    redirectLinksToggle: $('#redirectLinksToggle'), redirectLinksUrlInput: $('#redirectLinksUrlInput'),
    saveLinkRedirectButton: $('#saveLinkRedirectButton'), clearLinkRedirectButton: $('#clearLinkRedirectButton'),
    lockAdminButton: $('#lockAdminButton'), exportBackupButton: $('#exportBackupButton'), importBackupButton: $('#importBackupButton'),
    exportTermsButton: $('#exportTermsButton'), exportLinksButton: $('#exportLinksButton'), exportTldsButton: $('#exportTldsButton'),
    exportTrustedSitesButton: $('#exportTrustedSitesButton'), backupInput: $('#backupInput')
  });

  elements.enabledToggle.addEventListener('change', async () => {
    const requestedEnabled = elements.enabledToggle.checked;
    const wasEnabled = Boolean(state.settings.enabled);
    if (wasEnabled && !requestedEnabled) {
      elements.enabledToggle.checked = true;
      if (!window.confirm('Are you sure you want to disable blocker?')) return;
      const saved = await saveAdminSettings({ enabled: false }, 'Blocker disabled.');
      if (!saved) elements.enabledToggle.checked = true;
      return;
    }
    await saveAdminSettings({ enabled: requestedEnabled }, requestedEnabled ? 'Blocker enabled.' : 'Blocker disabled.');
  });
  elements.blockTermsToggle.addEventListener('change', () => void saveAdminSettings({ blockTerms: elements.blockTermsToggle.checked }));
  elements.blockLinksToggle.addEventListener('change', () => void saveAdminSettings({ blockLinks: elements.blockLinksToggle.checked }));
  elements.ttlSelect.addEventListener('change', () => void saveAdminSettings({ unlockTtlMinutes: Number(elements.ttlSelect.value) }));

  const saveTermRedirect = async () => {
    try {
      const url = normalizedRedirectOrError(elements.redirectTermsUrlInput, elements.redirectTermsToggle.checked);
      await saveAdminSettings({ redirectTerms: elements.redirectTermsToggle.checked, redirectTermsUrl: url }, 'Term redirect saved.');
    } catch (error) { toast(error.message); }
  };
  const saveLinkRedirect = async () => {
    try {
      const url = normalizedRedirectOrError(elements.redirectLinksUrlInput, elements.redirectLinksToggle.checked);
      await saveAdminSettings({ redirectLinks: elements.redirectLinksToggle.checked, redirectLinksUrl: url }, 'Link redirect saved.');
    } catch (error) { toast(error.message); }
  };

  elements.redirectTermsToggle.addEventListener('change', () => void saveTermRedirect());
  elements.saveTermRedirectButton.addEventListener('click', () => void saveTermRedirect());
  elements.redirectTermsUrlInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void saveTermRedirect(); }
  });
  elements.clearTermRedirectButton.addEventListener('click', () => {
    elements.redirectTermsToggle.checked = false;
    elements.redirectTermsUrlInput.value = '';
    void saveAdminSettings({ redirectTerms: false, redirectTermsUrl: '' }, 'Term redirect cleared.');
  });

  elements.redirectLinksToggle.addEventListener('change', () => void saveLinkRedirect());
  elements.saveLinkRedirectButton.addEventListener('click', () => void saveLinkRedirect());
  elements.redirectLinksUrlInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void saveLinkRedirect(); }
  });
  elements.clearLinkRedirectButton.addEventListener('click', () => {
    elements.redirectLinksToggle.checked = false;
    elements.redirectLinksUrlInput.value = '';
    void saveAdminSettings({ redirectLinks: false, redirectLinksUrl: '' }, 'Link redirect cleared.');
  });

  elements.exportBackupButton.addEventListener('click', () => {
    downloadText(`BraveFox-Blocker-Backup-${new Date().toISOString().slice(0, 10)}.json`, serializeFullBackup(state), 'application/json;charset=utf-8');
  });
  elements.exportTermsButton.addEventListener('click', () => {
    downloadText('BraveFox-Blocker-Terms.csv', serializeListCsv(state.terms), 'text/csv;charset=utf-8');
  });
  elements.exportLinksButton.addEventListener('click', () => {
    downloadText('BraveFox-Blocker-Links.csv', serializeListCsv(state.links), 'text/csv;charset=utf-8');
  });
  elements.exportTldsButton.addEventListener('click', () => {
    downloadText('BraveFox-Blocker-TLDs.csv', serializeListForKind(state.tlds, 'tlds'), 'text/csv;charset=utf-8');
  });
  elements.exportTrustedSitesButton.addEventListener('click', () => {
    downloadText('BraveFox-TrustedSites.csv', serializeListForKind(state.trustedSites, 'trustedSites'), 'text/csv;charset=utf-8');
  });
  elements.importBackupButton.addEventListener('click', () => elements.backupInput.click());
  elements.backupInput.addEventListener('change', async () => {
    const file = elements.backupInput.files?.[0];
    elements.backupInput.value = '';
    if (!file) return;
    try {
      const backup = parseFullBackup(await file.text());
      const tldSummary = Array.isArray(backup.tlds) ? `${backup.tlds.length} TLDs` : 'keep current TLDs';
      const trustedSummary = Array.isArray(backup.trustedSites) ? `${backup.trustedSites.length} trusted rules` : 'keep current trusted rules';
      if (!window.confirm(`Restore ${backup.terms.length} ordered terms, ${backup.links.length} ordered links, ${tldSummary}, ${trustedSummary} and protected settings?`)) return;
      const response = await message({ type: MESSAGE.replaceAll, ...backup }, { redirectOnLock: false });
      applyResponse(response);
      renderCounts();
      renderCurrentView();
      await renderAdminState();
      toast('Full ordered backup and protected settings restored.');
    } catch (error) {
      if (/settings are locked/i.test(error.message)) setAdminLockedUi();
      if (!lockingOut) toast(error.message);
    }
  });

  elements.lockAdminButton.addEventListener('click', async () => {
    try {
      await message({ type: MESSAGE.adminLock }, { redirectOnLock: false });
      setAdminLockedUi();
      toast('Settings locked.');
    } catch (error) { toast(error.message); }
  });

  bindSyncOpeners(elements.adminControls);
}

function bindListEditor({ kind, addInput, addButton, searchInput, importMode, importButton, exportButton, fileInput }) {
  addButton.addEventListener('click', async () => {
    const value = normalizerForKind(kind)(addInput.value);
    if (!value) return toast(`Enter a valid ${kindLabel(kind)} first.`);
    try {
      const response = await message({ type: MESSAGE.addItem, kind, value });
      applyResponse(response);
      addInput.value = '';
      renderCounts();
      renderCurrentView();
      toast('Entry appended; GitHub sync queued.');
    } catch (error) { if (!lockingOut) toast(error.message); }
  });
  addInput.addEventListener('keydown', event => { if (event.key === 'Enter') addButton.click(); });
  searchInput.addEventListener('input', renderCurrentView);
  importButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const values = parseListText(await file.text(), kind);
      if (!values.length) throw new Error('No usable entries were found in the file.');
      if (importMode.value === 'replace' && !confirm(`Replace the entire ${kindLabel(kind, 2)} list with ${values.length} ordered entries?`)) return;
      const response = await message({ type: MESSAGE.importList, kind, mode: importMode.value, values });
      applyResponse(response);
      renderCounts();
      renderCurrentView();
      toast(`${values.length} ordered entries imported; GitHub sync queued.`);
    } catch (error) { if (!lockingOut) toast(error.message); }
  });
  exportButton.addEventListener('click', () => {
    downloadText(exportNameForKind(kind), serializeListForKind(valuesForKind(kind), kind), 'text/csv;charset=utf-8');
  });
}

function bind() {
  Object.assign(elements, {
    app: $('#app'), termCount: $('#termCount'), linkTldCount: $('#linkTldCount'), trustedSiteCount: $('#trustedSiteCount'),
    linkSectionCount: $('#linkSectionCount'), tldSectionCount: $('#tldSectionCount'),
    viewTitle: $('#viewTitle'), viewSubtitle: $('#viewSubtitle'), singleListView: $('#singleListView'), linksTldsView: $('#linksTldsView'), settingsView: $('#settingsView'),
    trustedTypeBar: $('#trustedTypeBar'), trustedTypeFilter: $('#trustedTypeFilter'),
    addInput: $('#addInput'), addButton: $('#addButton'), searchInput: $('#searchInput'), importMode: $('#importMode'),
    importButton: $('#importButton'), exportButton: $('#exportButton'), fileInput: $('#fileInput'), items: $('#items'), emptyState: $('#emptyState'), singleListOrderNote: $('#singleListOrderNote'),
    addLinkInput: $('#addLinkInput'), addLinkButton: $('#addLinkButton'), linkSearchInput: $('#linkSearchInput'), linkImportMode: $('#linkImportMode'),
    linkImportButton: $('#linkImportButton'), linkExportButton: $('#linkExportButton'), linkFileInput: $('#linkFileInput'), linkItems: $('#linkItems'), linkEmptyState: $('#linkEmptyState'),
    addTldInput: $('#addTldInput'), addTldButton: $('#addTldButton'), tldSearchInput: $('#tldSearchInput'), tldImportMode: $('#tldImportMode'),
    tldImportButton: $('#tldImportButton'), tldExportButton: $('#tldExportButton'), tldFileInput: $('#tldFileInput'), tldItems: $('#tldItems'), tldEmptyState: $('#tldEmptyState'),
    adminLocked: $('#adminLocked'), adminUnlockForm: $('#adminUnlockForm'), adminPasswordInput: $('#adminPasswordInput'),
    adminUnlockButton: $('#adminUnlockButton'), adminError: $('#adminError'), adminControlsMount: $('#adminControlsMount'),
    lockButton: $('#lockButton'), toast: $('#toast'), syncLabel: $('#syncLabel'), syncDialog: $('#syncDialog'),
    closeSyncDialog: $('#closeSyncDialog'), githubTokenInput: $('#githubTokenInput'), tokenRecoveryToggle: $('#tokenRecoveryToggle'), automaticSyncToggle: $('#automaticSyncToggle'),
    clearGithubToken: $('#clearGithubToken'), githubSyncStatus: $('#githubSyncStatus'), termsRawLink: $('#termsRawLink'), linksRawLink: $('#linksRawLink'),
    tldsRawLink: $('#tldsRawLink'), trustedSitesRawLink: $('#trustedSitesRawLink'), syncProfileSelect: $('#syncProfileSelect'), syncProfileHelp: $('#syncProfileHelp'), detectedProfileStatus: $('#detectedProfileStatus'),
    saveGithubSyncSettings: $('#saveGithubSyncSettings'), downloadFromGithub: $('#downloadFromGithub'), uploadToGithub: $('#uploadToGithub')
  });

  document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => selectView(button.dataset.view)));

  // Terms and Trusted Sites share the simple single-list editor. The active
  // view decides which normalizer and GitHub-backed list receives the change.
  elements.addButton.addEventListener('click', async () => {
    const kind = currentSingleKind();
    const value = normalizerForKind(kind)(elements.addInput.value);
    if (!value) return toast(`Enter a valid ${kindLabel(kind)} first.`);
    const trustedType = kind === 'trustedSites' ? parseTrustedSiteEntry(value)?.type : '';
    try {
      const response = await message({ type: MESSAGE.addItem, kind, value });
      applyResponse(response);
      if (trustedType === 'domain' || trustedType === 'path') state.trustedSiteFilter = trustedType;
      elements.addInput.value = '';
      renderCounts();
      renderCurrentView();
      toast('Entry appended; GitHub sync queued.');
    } catch (error) { if (!lockingOut) toast(error.message); }
  });
  elements.addInput.addEventListener('keydown', event => { if (event.key === 'Enter') elements.addButton.click(); });
  elements.searchInput.addEventListener('input', renderCurrentView);
  elements.trustedTypeFilter.addEventListener('change', () => {
    state.trustedSiteFilter = elements.trustedTypeFilter.value === 'path' ? 'path' : 'domain';
    updateTrustedTypeFilterUi();
    renderCurrentView();
  });
  elements.importButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', async () => {
    const file = elements.fileInput.files?.[0];
    elements.fileInput.value = '';
    if (!file) return;
    const kind = currentSingleKind();
    try {
      const values = parseListText(await file.text(), kind);
      if (!values.length) throw new Error('No usable entries were found in the file.');
      if (elements.importMode.value === 'replace' && !confirm(`Replace the entire ${kindLabel(kind, 2)} list with ${values.length} ordered entries?`)) return;
      const response = await message({ type: MESSAGE.importList, kind, mode: elements.importMode.value, values });
      applyResponse(response);
      renderCounts();
      renderCurrentView();
      toast(`${values.length} ordered entries imported; GitHub sync queued.`);
    } catch (error) { if (!lockingOut) toast(error.message); }
  });
  elements.exportButton.addEventListener('click', () => {
    const kind = currentSingleKind();
    downloadText(exportNameForKind(kind), serializeListForKind(valuesForKind(kind), kind), 'text/csv;charset=utf-8');
  });

  bindListEditor({
    kind: 'links', addInput: elements.addLinkInput, addButton: elements.addLinkButton,
    searchInput: elements.linkSearchInput, importMode: elements.linkImportMode,
    importButton: elements.linkImportButton, exportButton: elements.linkExportButton, fileInput: elements.linkFileInput
  });
  bindListEditor({
    kind: 'tlds', addInput: elements.addTldInput, addButton: elements.addTldButton,
    searchInput: elements.tldSearchInput, importMode: elements.tldImportMode,
    importButton: elements.tldImportButton, exportButton: elements.tldExportButton, fileInput: elements.tldFileInput
  });

  elements.adminUnlockForm.addEventListener('submit', async event => {
    event.preventDefault();
    elements.adminError.textContent = '';
    elements.adminUnlockButton.disabled = true;
    elements.adminPasswordInput.disabled = true;
    try {
      const response = await message({ type: MESSAGE.adminUnlock, password: elements.adminPasswordInput.value });
      if (!response.adminUnlocked) throw new Error('Incorrect password.');
      applyResponse(response);
      await renderAdminState();
      toast('Settings unlocked for five minutes.');
    } catch (error) {
      elements.adminError.textContent = error.message;
      elements.adminPasswordInput.select();
    } finally {
      elements.adminUnlockButton.disabled = false;
      elements.adminPasswordInput.disabled = false;
      elements.adminPasswordInput.focus();
    }
  });

  bindSyncOpeners(document);
  bindGithubSyncDialog();

  elements.lockButton.addEventListener('click', async () => {
    try {
      await message({ type: MESSAGE.lock });
      secureLockout(true);
    } catch (error) { if (!lockingOut) toast(error.message); }
  });
}

async function checkAccess() {
  try {
    const response = await message({ type: MESSAGE.checkAccess }, { redirectOnLock: false });
    if (!response.unlocked) {
      secureLockout(Boolean(response.registered));
      return;
    }
    if (state.adminUnlocked !== Boolean(response.adminUnlocked)) {
      state.adminUnlocked = Boolean(response.adminUnlocked);
      if (state.view === 'settings') await renderAdminState();
    }
  } catch {
    secureLockout(true);
  }
}

function startAccessWatcher() {
  accessTimer = setInterval(() => void checkAccess(), 1500);
  window.addEventListener('focus', () => void checkAccess());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkAccess(); });
}

async function start() {
  if (browser.extension?.inIncognitoContext) {
    location.replace('incognito-denied.html');
    return;
  }

  const bootstrap = await message({ type: MESSAGE.getBootstrap }, { redirectOnLock: false });
  if (!bootstrap.unlocked) {
    if (!bootstrap.registered) openPopupRequiredPage();
    else openNativePasswordPage();
    return;
  }

  const response = await message({ type: MESSAGE.getState }, { redirectOnLock: false });
  await loadUiFragment();
  bind();
  applyResponse(response);
  renderCounts();
  renderCurrentView();
  if (state.adminUnlocked) await renderAdminState();
  else setAdminLockedUi();
  startAccessWatcher();
}

start().catch(error => {
  if (isLockError(error.message)) {
    secureLockout(true);
    return;
  }
  document.body.replaceChildren();
  const failure = document.createElement('main');
  failure.style.cssText = 'font:16px system-ui;padding:32px;max-width:760px;margin:auto;color:#7f1d1d';
  failure.textContent = `BraveFox Focus Master failed to open: ${error.message}`;
  document.body.appendChild(failure);
});
