export const BLOCKER_VERSION = '1.0.0-beta.4';

export const STORAGE_KEYS = Object.freeze({
  datasetMeta: 'bfb:dataset-meta',
  settings: 'bfb:settings',
  auth: 'bfb:auth',
  session: 'bfb:session',
  localDataset: 'bfb:local-dataset',
  localSettings: 'bfb:local-settings',
  managerSessions: 'bfb:manager-sessions',
  managerTabs: 'bfb:manager-tabs',
  adminSessions: 'bfb:admin-sessions'
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  blockTerms: true,
  blockLinks: true,
  lockManager: true,
  unlockTtlMinutes: 5,
  redirectTerms: false,
  redirectTermsUrl: '',
  redirectLinks: false,
  redirectLinksUrl: ''
});

export const MESSAGE = Object.freeze({
  getBootstrap: 'BFB_GET_BOOTSTRAP',
  getState: 'BFB_GET_STATE',
  checkAccess: 'BFB_CHECK_ACCESS',
  popupUnlockOpen: 'BFB_POPUP_UNLOCK_OPEN',
  quickAddItem: 'BFB_QUICK_ADD_ITEM',
  unlock: 'BFB_UNLOCK',
  lock: 'BFB_LOCK',
  adminUnlock: 'BFB_ADMIN_UNLOCK',
  adminLock: 'BFB_ADMIN_LOCK',
  updateAdminSettings: 'BFB_UPDATE_ADMIN_SETTINGS',
  addItem: 'BFB_ADD_ITEM',
  removeItem: 'BFB_REMOVE_ITEM',
  importList: 'BFB_IMPORT_LIST',
  replaceAll: 'BFB_REPLACE_ALL',
  syncNow: 'BFB_SYNC_NOW',
  getGitHubSyncStatus: 'BFB_GET_GITHUB_SYNC_STATUS',
  saveGitHubSyncConfig: 'BFB_SAVE_GITHUB_SYNC_CONFIG',
  downloadGitHubLists: 'BFB_DOWNLOAD_GITHUB_LISTS',
  uploadGitHubLists: 'BFB_UPLOAD_GITHUB_LISTS',
  openManager: 'BFB_OPEN_MANAGER'
});

export const DATASET_PREFIX = 'bfb:data:';
export const MAX_CHUNK_BYTES = 6500;
export const ADMIN_SESSION_TTL_MS = 5 * 60 * 1000;
