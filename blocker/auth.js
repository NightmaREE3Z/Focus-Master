import {
  ADMIN_SESSION_TTL_MS,
  STORAGE_KEYS
} from './constants.js';
import { getSettings } from './storage.js';

// Private BraveFox build: shared with the established BraveFox password page.
// This is a strong friction layer inside the extension, not a boundary against
// the browser profile owner editing or disabling an unpacked extension.
const FIXED_PASSWORD = '5u89asyadhy2adhg9uh3572y1';

function validTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

async function getSessionMap(key) {
  const result = await chrome.storage.session.get(key);
  const value = result[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function setSessionMap(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

function pruneTimedMap(map, now = Date.now()) {
  const next = {};
  for (const [key, value] of Object.entries(map || {})) {
    if (value && Number(value.expiresAt) > now) next[key] = value;
  }
  return next;
}

async function removeMapEntry(key, tabId) {
  if (!validTabId(tabId)) return;
  const map = pruneTimedMap(await getSessionMap(key));
  delete map[String(tabId)];
  await setSessionMap(key, map);
}

export async function hasPassword() {
  return true;
}

export async function verifyPassword(password) {
  return String(password || '') === FIXED_PASSWORD;
}

export async function registerManagerTab(tabId) {
  if (!validTabId(tabId)) throw new Error('Manager tab could not be identified.');
  const tabs = await getSessionMap(STORAGE_KEYS.managerTabs);
  tabs[String(tabId)] = { registeredAt: Date.now() };
  await setSessionMap(STORAGE_KEYS.managerTabs, tabs);
}

export async function isRegisteredManagerTab(tabId) {
  if (!validTabId(tabId)) return false;
  const tabs = await getSessionMap(STORAGE_KEYS.managerTabs);
  return Boolean(tabs[String(tabId)]);
}

export async function establishManagerSession(tabId) {
  if (!validTabId(tabId)) throw new Error('Manager tab could not be identified.');
  if (!(await isRegisteredManagerTab(tabId))) throw new Error('Manager tab is not trusted.');
  const settings = await getSettings();
  const ttl = Math.max(1, Number(settings.unlockTtlMinutes) || 5) * 60 * 1000;
  const sessions = pruneTimedMap(await getSessionMap(STORAGE_KEYS.managerSessions));
  sessions[String(tabId)] = { expiresAt: Date.now() + ttl };
  await setSessionMap(STORAGE_KEYS.managerSessions, sessions);
}

export async function reauthenticateManagerTab(password, tabId) {
  if (!(await verifyPassword(password))) return false;
  if (!(await isRegisteredManagerTab(tabId))) return false;
  await establishManagerSession(tabId);
  // A manager re-authentication never silently revives Admin settings.
  await removeMapEntry(STORAGE_KEYS.adminSessions, tabId);
  return true;
}

export async function isManagerTabUnlocked(tabId) {
  if (!validTabId(tabId) || !(await isRegisteredManagerTab(tabId))) return false;
  const sessions = pruneTimedMap(await getSessionMap(STORAGE_KEYS.managerSessions));
  const unlocked = Boolean(sessions[String(tabId)]);
  await setSessionMap(STORAGE_KEYS.managerSessions, sessions);
  if (!unlocked) await removeMapEntry(STORAGE_KEYS.adminSessions, tabId);
  return unlocked;
}

export async function unlockAdminTab(password, tabId) {
  if (!(await verifyPassword(password))) return false;
  if (!(await isManagerTabUnlocked(tabId))) return false;
  const sessions = pruneTimedMap(await getSessionMap(STORAGE_KEYS.adminSessions));
  sessions[String(tabId)] = { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS };
  await setSessionMap(STORAGE_KEYS.adminSessions, sessions);
  return true;
}

export async function isAdminTabUnlocked(tabId) {
  if (!(await isManagerTabUnlocked(tabId))) return false;
  const sessions = pruneTimedMap(await getSessionMap(STORAGE_KEYS.adminSessions));
  const unlocked = Boolean(sessions[String(tabId)]);
  await setSessionMap(STORAGE_KEYS.adminSessions, sessions);
  return unlocked;
}

export async function touchAdminTab(tabId) {
  if (!(await isAdminTabUnlocked(tabId))) return false;
  const sessions = pruneTimedMap(await getSessionMap(STORAGE_KEYS.adminSessions));
  sessions[String(tabId)] = { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS };
  await setSessionMap(STORAGE_KEYS.adminSessions, sessions);
  return true;
}

export async function lockAdminTab(tabId) {
  await removeMapEntry(STORAGE_KEYS.adminSessions, tabId);
}

export async function lockManagerTab(tabId) {
  if (!validTabId(tabId)) return;
  await Promise.all([
    removeMapEntry(STORAGE_KEYS.managerSessions, tabId),
    removeMapEntry(STORAGE_KEYS.adminSessions, tabId)
  ]);
}

export async function cleanupTabAuth(tabId) {
  if (!validTabId(tabId)) return;
  const [managerSessions, adminSessions, tabs] = await Promise.all([
    getSessionMap(STORAGE_KEYS.managerSessions),
    getSessionMap(STORAGE_KEYS.adminSessions),
    getSessionMap(STORAGE_KEYS.managerTabs)
  ]);
  delete managerSessions[String(tabId)];
  delete adminSessions[String(tabId)];
  delete tabs[String(tabId)];
  await Promise.all([
    setSessionMap(STORAGE_KEYS.managerSessions, pruneTimedMap(managerSessions)),
    setSessionMap(STORAGE_KEYS.adminSessions, pruneTimedMap(adminSessions)),
    setSessionMap(STORAGE_KEYS.managerTabs, tabs)
  ]);
}

// Compatibility exports retained for older module callers.
export async function isUnlocked() { return false; }
export async function unlock() { return false; }
export async function lock() { return true; }
export async function setPassword(password) {
  if (!(await verifyPassword(password))) throw new Error('This private build uses the fixed BraveFox password.');
  return true;
}
export async function changePassword() {
  throw new Error('The BraveFox Focus Master password is fixed in this private build.');
}
