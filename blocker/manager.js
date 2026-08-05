import { browser } from './api.js';
import { MESSAGE } from './constants.js';
import {
  parseFullBackup,
  parseListText,
  serializeFullBackup,
  serializeListCsv
} from './csv.js';
import { downloadText, normalizeLinkForStorage, normalizeRedirectUrl, normalizeTerm } from './shared.js';

const state = {
  view: 'terms',
  terms: [],
  links: [],
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

function currentValues() {
  return state.view === 'links' ? state.links : state.terms;
}

function applyResponse(response) {
  if (Array.isArray(response.terms)) state.terms = response.terms;
  if (Array.isArray(response.links)) state.links = response.links;
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
    elements.syncLabel.title = 'Open Sync to configure public GitHub blocklist synchronization.';
  }
}

function renderCounts() {
  elements.termCount.textContent = state.terms.length;
  elements.linkCount.textContent = state.links.length;
}

function renderList() {
  const search = elements.searchInput.value.trim().toLocaleLowerCase('en-US');
  const values = currentValues().filter(value => !search || value.toLocaleLowerCase('en-US').includes(search));
  elements.items.replaceChildren();
  elements.emptyState.hidden = values.length > 0;

  const fragment = document.createDocumentFragment();
  for (const value of values) {
    const row = document.createElement('div');
    row.className = 'item';
    row.setAttribute('role', 'listitem');

    const label = document.createElement('div');
    label.className = 'item-value';
    label.textContent = value;

    const remove = document.createElement('button');
    remove.className = 'remove-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove “${value}”?`)) return;
      try {
        const response = await message({ type: MESSAGE.removeItem, kind: state.view, value });
        applyResponse(response);
        renderCounts();
        renderList();
        toast('Entry removed; GitHub sync queued.');
      } catch (error) {
        if (!lockingOut) toast(error.message);
      }
    });

    row.append(label, remove);
    fragment.appendChild(row);
  }
  elements.items.appendChild(fragment);
}

function selectView(view) {
  state.view = view;
  for (const button of document.querySelectorAll('.nav-button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  const settings = view === 'settings';
  elements.listView.hidden = settings;
  elements.settingsView.hidden = !settings;

  if (view === 'terms') {
    elements.viewTitle.textContent = 'Blocked terms';
    elements.viewSubtitle.textContent = 'Manage words and phrases that trigger blocking.';
    elements.addInput.placeholder = 'Add a term or phrase';
  } else if (view === 'links') {
    elements.viewTitle.textContent = 'Blocked links';
    elements.viewSubtitle.textContent = 'Manage domains, website paths and URL patterns.';
    elements.addInput.placeholder = 'Add a domain or URL';
  } else {
    elements.viewTitle.textContent = 'Settings';
    elements.viewSubtitle.textContent = 'Password-protected enforcement controls, synchronization and backups.';
    void renderAdminState();
  }
  if (!settings) renderList();
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
  lines.push(`Pending changes: ${Number(sync.pendingCount) || 0}`);
  if (sync.lastSyncAt) lines.push(`Last sync: ${new Date(sync.lastSyncAt).toLocaleString()} — ${sync.lastAction || 'completed'}`);
  else lines.push('Last sync: never');
  if (sync.trustedSites) lines.push(`Trusted sites: ${sync.trustedSites.count || 0} (${sync.trustedSites.source || 'unknown'})`);
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
  if (files?.trustedSites?.rawUrl && elements.trustedSitesRawLink) elements.trustedSitesRawLink.href = files.trustedSites.rawUrl;
  if (files?.terms?.path && elements.termsRawLink) elements.termsRawLink.textContent = files.terms.path.split('/').pop();
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
    } else if (!window.confirm(`Download ${state.githubSync?.activeProfileLabel || 'the selected profile'} terms plus the global links from GitHub and replace the current local lists?`)) {
      return;
    }

    const response = await message({
      type: action === 'upload' ? MESSAGE.uploadGitHubLists : MESSAGE.downloadGitHubLists
    });
    applyResponse(response);
    renderCounts();
    if (state.view !== 'settings') renderList();
    renderGithubSyncDialogStatus(response.githubSync);
    if (action === 'download' && response.usedBundledFallback) {
      toast('GitHub was unavailable. Packaged fallback lists were loaded.');
    } else {
      toast(action === 'upload' ? 'Blocklists uploaded to GitHub.' : 'Blocklists downloaded from GitHub.');
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
      await saveGithubSettings();
      toast('GitHub sync settings saved.');
    } catch (error) {
      if (!lockingOut) toast(error.message);
    } finally {
      elements.saveGithubSyncSettings.disabled = false;
      elements.saveGithubSyncSettings.textContent = original;
    }
  });
  elements.clearGithubToken.addEventListener('click', async () => {
    if (!window.confirm('Forget the GitHub token saved on this device?')) return;
    try {
      const response = await message({
        type: MESSAGE.saveGitHubSyncConfig,
        autoSync: elements.automaticSyncToggle.checked,
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
    exportTermsButton: $('#exportTermsButton'), exportLinksButton: $('#exportLinksButton'), backupInput: $('#backupInput')
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
  elements.importBackupButton.addEventListener('click', () => elements.backupInput.click());
  elements.backupInput.addEventListener('change', async () => {
    const file = elements.backupInput.files?.[0];
    elements.backupInput.value = '';
    if (!file) return;
    try {
      const backup = parseFullBackup(await file.text());
      if (!window.confirm(`Restore ${backup.terms.length} ordered terms, ${backup.links.length} ordered links and protected settings?`)) return;
      const response = await message({ type: MESSAGE.replaceAll, ...backup }, { redirectOnLock: false });
      applyResponse(response);
      renderCounts();
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

function bind() {
  Object.assign(elements, {
    app: $('#app'), termCount: $('#termCount'), linkCount: $('#linkCount'),
    viewTitle: $('#viewTitle'), viewSubtitle: $('#viewSubtitle'), listView: $('#listView'), settingsView: $('#settingsView'),
    addInput: $('#addInput'), addButton: $('#addButton'), searchInput: $('#searchInput'), importMode: $('#importMode'),
    importButton: $('#importButton'), exportButton: $('#exportButton'), fileInput: $('#fileInput'), items: $('#items'), emptyState: $('#emptyState'),
    adminLocked: $('#adminLocked'), adminUnlockForm: $('#adminUnlockForm'), adminPasswordInput: $('#adminPasswordInput'),
    adminUnlockButton: $('#adminUnlockButton'), adminError: $('#adminError'), adminControlsMount: $('#adminControlsMount'),
    lockButton: $('#lockButton'), toast: $('#toast'), syncLabel: $('#syncLabel'), syncDialog: $('#syncDialog'),
    closeSyncDialog: $('#closeSyncDialog'), githubTokenInput: $('#githubTokenInput'), automaticSyncToggle: $('#automaticSyncToggle'),
    clearGithubToken: $('#clearGithubToken'), githubSyncStatus: $('#githubSyncStatus'), termsRawLink: $('#termsRawLink'), linksRawLink: $('#linksRawLink'),
    trustedSitesRawLink: $('#trustedSitesRawLink'), syncProfileSelect: $('#syncProfileSelect'), syncProfileHelp: $('#syncProfileHelp'), detectedProfileStatus: $('#detectedProfileStatus'),
    saveGithubSyncSettings: $('#saveGithubSyncSettings'), downloadFromGithub: $('#downloadFromGithub'), uploadToGithub: $('#uploadToGithub')
  });

  document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => selectView(button.dataset.view)));

  elements.addButton.addEventListener('click', async () => {
    const raw = elements.addInput.value;
    const value = state.view === 'links' ? normalizeLinkForStorage(raw) : normalizeTerm(raw);
    if (!value) return toast('Enter a valid value first.');
    try {
      const response = await message({ type: MESSAGE.addItem, kind: state.view, value });
      applyResponse(response);
      elements.addInput.value = '';
      renderCounts();
      renderList();
      toast('Entry appended; GitHub sync queued.');
    } catch (error) { if (!lockingOut) toast(error.message); }
  });
  elements.addInput.addEventListener('keydown', event => { if (event.key === 'Enter') elements.addButton.click(); });
  elements.searchInput.addEventListener('input', renderList);
  elements.importButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', async () => {
    const file = elements.fileInput.files?.[0];
    elements.fileInput.value = '';
    if (!file) return;
    try {
      const values = parseListText(await file.text(), state.view);
      if (!values.length) throw new Error('No usable entries were found in the file.');
      if (elements.importMode.value === 'replace' && !confirm(`Replace the entire ${state.view} list with ${values.length} ordered entries?`)) return;
      const response = await message({ type: MESSAGE.importList, kind: state.view, mode: elements.importMode.value, values });
      applyResponse(response);
      renderCounts();
      renderList();
      toast(`${values.length} ordered entries imported; GitHub sync queued.`);
    } catch (error) { if (!lockingOut) toast(error.message); }
  });
  elements.exportButton.addEventListener('click', () => {
    const name = state.view === 'terms' ? 'BraveFox-Blocker-Terms.csv' : 'BraveFox-Blocker-Links.csv';
    downloadText(name, serializeListCsv(currentValues()), 'text/csv;charset=utf-8');
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
  renderList();
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
