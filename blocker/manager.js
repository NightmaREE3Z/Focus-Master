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
  window.location.replace(chrome.runtime.getURL(`html/password-protected.html?${params.toString()}`));
}

function openPopupRequiredPage() {
  window.location.replace(chrome.runtime.getURL('blocker/popup-required.html'));
}

function secureLockout(registered = true) {
  if (lockingOut) return;
  lockingOut = true;
  if (accessTimer) clearInterval(accessTimer);
  document.body.replaceChildren();
  if (registered) openNativePasswordPage();
  else openPopupRequiredPage();
}

function message(payload, { redirectOnLock = true } = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, response => {
      const runtimeError = chrome.runtime.lastError;
      const errorText = runtimeError?.message || (!response?.ok ? (response?.error || 'BraveFox Focus Master request failed.') : '');
      if (errorText) {
        if (redirectOnLock && isLockError(errorText)) secureLockout(true);
        reject(new Error(errorText || 'BraveFox Focus Master request failed.'));
        return;
      }
      resolve(response);
    });
  });
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
  if (typeof response.adminUnlocked === 'boolean') state.adminUnlocked = response.adminUnlocked;
  renderStorageStatus();
}

function renderStorageStatus() {
  if (!elements.syncLabel) return;
  if (state.storageStatus?.syncPending) {
    elements.syncLabel.textContent = 'Saved locally — Chrome Sync pending';
    elements.syncLabel.title = state.storageStatus.syncError || 'Chrome will retry profile synchronization.';
  } else {
    elements.syncLabel.textContent = 'Saved locally + Chrome profile sync';
    elements.syncLabel.title = 'The local mirror survives browser restarts; Chrome Sync carries the lists to your other signed-in browsers.';
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
        toast('Entry removed and synced.');
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

async function loadFragment(path) {
  const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${path}.`);
  return response.text();
}

async function loadUiFragment() {
  document.body.innerHTML = await loadFragment('blocker/manager-ui.html');
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
    elements.adminControlsMount.innerHTML = await loadFragment('blocker/admin-ui.html');
    bindAdminControls();
  }
  elements.adminLocked.hidden = true;
  setAdminDependentState();
}

async function saveAdminSettings(patch, successMessage = 'Settings saved and synced.') {
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

async function runManualSync(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    const response = await message({ type: MESSAGE.syncNow });
    applyResponse(response);
    renderCounts();
    if (state.view !== 'settings') renderList();
    if (state.view === 'settings') await renderAdminState();
    toast(state.storageStatus?.syncPending ? 'Saved locally. Chrome profile sync is still pending.' : 'Manual Chrome profile sync completed.');
  } catch (error) {
    if (!lockingOut) toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original || 'Sync now';
  }
}

function bindSyncButtons(root = document) {
  root.querySelectorAll('[data-sync-now]').forEach(button => {
    if (button.dataset.syncBound === 'true') return;
    button.dataset.syncBound = 'true';
    button.addEventListener('click', () => void runManualSync(button));
  });
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
      if (!window.confirm('Are you sure you want to disable Focus Master?')) return;
      const saved = await saveAdminSettings({ enabled: false }, 'Focus Master disabled.');
      if (!saved) elements.enabledToggle.checked = true;
      return;
    }
    await saveAdminSettings({ enabled: requestedEnabled }, requestedEnabled ? 'Focus Master enabled.' : 'Focus Master disabled.');
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
    downloadText(`BraveFox-Focus-Master-Backup-${new Date().toISOString().slice(0, 10)}.json`, serializeFullBackup(state), 'application/json;charset=utf-8');
  });
  elements.exportTermsButton.addEventListener('click', () => {
    downloadText('BraveFox-Focus-Master-Terms.csv', serializeListCsv(state.terms), 'text/csv;charset=utf-8');
  });
  elements.exportLinksButton.addEventListener('click', () => {
    downloadText('BraveFox-Focus-Master-Links.csv', serializeListCsv(state.links), 'text/csv;charset=utf-8');
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

  bindSyncButtons(elements.adminControls);
}

function bind() {
  Object.assign(elements, {
    app: $('#app'), termCount: $('#termCount'), linkCount: $('#linkCount'),
    viewTitle: $('#viewTitle'), viewSubtitle: $('#viewSubtitle'), listView: $('#listView'), settingsView: $('#settingsView'),
    addInput: $('#addInput'), addButton: $('#addButton'), searchInput: $('#searchInput'), importMode: $('#importMode'),
    importButton: $('#importButton'), exportButton: $('#exportButton'), fileInput: $('#fileInput'), items: $('#items'), emptyState: $('#emptyState'),
    adminLocked: $('#adminLocked'), adminUnlockForm: $('#adminUnlockForm'), adminPasswordInput: $('#adminPasswordInput'),
    adminUnlockButton: $('#adminUnlockButton'), adminError: $('#adminError'), adminControlsMount: $('#adminControlsMount'),
    lockButton: $('#lockButton'), toast: $('#toast'), syncLabel: $('#syncLabel')
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
      toast('Entry appended and synced.');
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
      toast(`${values.length} ordered entries imported and synced.`);
    } catch (error) { if (!lockingOut) toast(error.message); }
  });
  elements.exportButton.addEventListener('click', () => {
    const name = state.view === 'terms' ? 'BraveFox-Focus-Master-Terms.csv' : 'BraveFox-Focus-Master-Links.csv';
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


  bindSyncButtons(document);

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
  if (chrome.extension?.inIncognitoContext) {
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
