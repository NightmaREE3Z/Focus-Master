// BraveFox Focus Master time rules — 2026-08-21
// Scheduled site blocks and per-profile daily usage quotas.

import { browser } from './api.js';
import { STORAGE_KEYS } from './constants.js';
import { matchLink } from './matcher.js';
import { normalizeLinkForStorage } from './shared.js';

const VALID_PROFILES = new Set(['haukkis', 'tapsa']);
const MAX_RULES_PER_KIND = 20;
const SAMPLE_CAP_MS = 90 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TRACKER_CONTEXT = chrome.extension?.inIncognitoContext ? 'incognito' : 'normal';
const USAGE_ALARM = `bfb-time-rule-usage-${TRACKER_CONTEXT}`;
const DEADLINE_ALARM = `bfb-time-rule-deadline-${TRACKER_CONTEXT}`;
const SCHEDULE_BOUNDARY_ALARM = `bfb-time-rule-schedule-boundary-${TRACKER_CONTEXT}`;
const WATCHDOG_MINUTES = 0.5;
const DEADLINE_FLOOR_MS = 250;

function normalizeProfile(value) {
  return VALID_PROFILES.has(value) ? value : 'haukkis';
}

export function normalizeClockTime(value, fallback = '00:00') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function simpleHash(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cleanRuleId(value, fallbackSeed) {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return cleaned || `rule-${simpleHash(fallbackSeed)}`;
}

function normalizeScheduledRule(value, index = 0) {
  const source = value && typeof value === 'object' ? value : {};
  const link = normalizeLinkForStorage(source.link || source.target || source.url);
  if (!link) return null;
  const profile = normalizeProfile(source.profile);
  const startTime = normalizeClockTime(source.startTime || source.start, '22:00');
  const endTime = normalizeClockTime(source.endTime || source.end, '10:00');
  const id = cleanRuleId(source.id, `scheduled:${profile}:${link}:${startTime}:${endTime}:${index}`);
  return { id, profile, link, startTime, endTime, enabled: source.enabled !== false };
}

function normalizeQuotaRule(value, index = 0) {
  const source = value && typeof value === 'object' ? value : {};
  const link = normalizeLinkForStorage(source.link || source.target || source.url);
  if (!link) return null;
  const profile = normalizeProfile(source.profile);
  const minutes = Math.min(1440, Math.max(1, Math.round(Number(source.minutes) || 1)));
  const resetTime = normalizeClockTime(source.resetTime || source.reset, '10:00');
  const id = cleanRuleId(source.id, `quota:${profile}:${link}:${minutes}:${resetTime}:${index}`);
  return { id, profile, link, minutes, resetTime, enabled: source.enabled !== false };
}

function uniqueRules(values, normalizer) {
  const seen = new Set();
  const output = [];
  for (const [index, raw] of (Array.isArray(values) ? values : []).entries()) {
    const rule = normalizer(raw, index);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    output.push(rule);
    if (output.length >= MAX_RULES_PER_KIND) break;
  }
  return output;
}

export function normalizeScheduledRules(values) {
  return uniqueRules(values, normalizeScheduledRule);
}

export function normalizeQuotaRules(values) {
  return uniqueRules(values, normalizeQuotaRule);
}

function clockMinutes(value) {
  const normalized = normalizeClockTime(value, '00:00');
  const [hour, minute] = normalized.split(':').map(Number);
  return (hour * 60) + minute;
}

function localMinutes(date) {
  return (date.getHours() * 60) + date.getMinutes();
}

function isScheduleActive(rule, date) {
  const start = clockMinutes(rule.startTime);
  const end = clockMinutes(rule.endTime);
  const current = localMinutes(date);
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function profileRules(settings, key, profile) {
  const expected = normalizeProfile(profile);
  const values = key === 'scheduledRules'
    ? normalizeScheduledRules(settings?.scheduledRules)
    : normalizeQuotaRules(settings?.quotaRules);
  return values.filter(rule => rule.enabled && rule.profile === expected);
}

function linkMatches(url, rule) {
  return Boolean(matchLink(url, [rule.link]));
}

export function findScheduledBlock(url, settings, profile, at = Date.now()) {
  if (!settings?.enabled) return null;
  const date = new Date(at);
  for (const rule of profileRules(settings, 'scheduledRules', profile)) {
    if (!isScheduleActive(rule, date) || !linkMatches(url, rule)) continue;
    return {
      type: 'schedule',
      trigger: rule.link,
      attemptedSearch: `Scheduled block ${rule.startTime}–${rule.endTime}`,
      rule
    };
  }
  return null;
}

function periodStartFor(resetTime, nowMs) {
  const now = new Date(nowMs);
  const [hour, minute] = normalizeClockTime(resetTime, '10:00').split(':').map(Number);
  const start = new Date(now);
  start.setHours(hour, minute, 0, 0);
  if (now.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
  return start.getTime();
}

function normalizeUsageState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const entries = source.entries && typeof source.entries === 'object' ? source.entries : {};
  return { version: 1, entries: { ...entries } };
}

async function readUsageState() {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.timerUsage);
    return normalizeUsageState(result[STORAGE_KEYS.timerUsage]);
  } catch {
    return normalizeUsageState(null);
  }
}

async function writeUsageState(state) {
  try { await browser.storage.local.set({ [STORAGE_KEYS.timerUsage]: normalizeUsageState(state) }); } catch {}
}

function usageKey(rule) {
  return `${rule.profile}:${rule.id}`;
}

function normalizedUsageEntry(raw, rule, nowMs) {
  const expectedStart = periodStartFor(rule.resetTime, nowMs);
  const source = raw && typeof raw === 'object' ? raw : {};
  if (Number(source.periodStart) !== expectedStart) {
    return { periodStart: expectedStart, usedMs: 0, updatedAt: nowMs };
  }
  return {
    periodStart: expectedStart,
    usedMs: Math.max(0, Number(source.usedMs) || 0),
    updatedAt: Number(source.updatedAt) || nowMs
  };
}

export async function findQuotaBlock(url, settings, profile, at = Date.now()) {
  if (!settings?.enabled) return null;
  const rules = profileRules(settings, 'quotaRules', profile).filter(rule => linkMatches(url, rule));
  if (!rules.length) return null;
  const state = await readUsageState();
  let repaired = false;

  for (const rule of rules) {
    const key = usageKey(rule);
    const entry = normalizedUsageEntry(state.entries[key], rule, at);
    if (!state.entries[key] || Number(state.entries[key].periodStart) !== entry.periodStart) {
      state.entries[key] = entry;
      repaired = true;
    }
    if (entry.usedMs >= rule.minutes * MINUTE_MS) {
      if (repaired) await writeUsageState(state);
      return {
        type: 'quota',
        trigger: rule.link,
        attemptedSearch: `Daily limit ${rule.minutes} min — resets ${rule.resetTime}`,
        rule,
        usedMs: entry.usedMs
      };
    }
  }

  if (repaired) await writeUsageState(state);
  return null;
}

export async function findTimeRuleBlock(url, settings, profile, at = Date.now()) {
  // Scheduled blocks and daily-use quotas intentionally share one enforcement
  // priority. Evaluate both before Trusted Sites. If both are active at once,
  // the schedule is returned only to choose the clearer "blocked until HH:MM"
  // presentation; neither rule type has stronger blocking authority.
  const scheduled = findScheduledBlock(url, settings, profile, at);
  const quota = await findQuotaBlock(url, settings, profile, at);
  return scheduled || quota;
}

function trackerRuleDescriptor(rule) {
  return {
    id: rule.id,
    profile: rule.profile,
    link: rule.link,
    minutes: rule.minutes,
    resetTime: rule.resetTime,
    enabled: rule.enabled !== false
  };
}

async function readTrackerState() {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.timerTracker);
    const root = result[STORAGE_KEYS.timerTracker];
    return root && typeof root === 'object' ? { ...root } : {};
  } catch { return {}; }
}

async function writeTrackerState(root) {
  try { await browser.storage.local.set({ [STORAGE_KEYS.timerTracker]: root }); } catch {}
}

async function addUsage(previousRules, elapsedMs, nowMs) {
  if (!Array.isArray(previousRules) || !previousRules.length || elapsedMs <= 0) return;
  const state = await readUsageState();
  for (const descriptor of previousRules) {
    const rule = normalizeQuotaRule(descriptor);
    if (!rule) continue;
    const key = usageKey(rule);
    const entry = normalizedUsageEntry(state.entries[key], rule, nowMs);
    entry.usedMs += elapsedMs;
    entry.updatedAt = nowMs;
    state.entries[key] = entry;
  }
  await writeUsageState(state);
}

async function focusedActiveTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs?.[0];
    if (!tab || !Number.isInteger(tab.id) || !tab.url) return null;
    try {
      const windowInfo = await browser.windows.get(tab.windowId);
      if (windowInfo && windowInfo.focused === false) return null;
    } catch {}
    return tab;
  } catch { return null; }
}

async function clearDeadlineAlarm() {
  try { await browser.alarms.clear(DEADLINE_ALARM); } catch {}
}

function nextLocalClockOccurrence(clockTime, nowMs) {
  const [hour, minute] = normalizeClockTime(clockTime, '00:00').split(':').map(Number);
  const candidate = new Date(nowMs);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= nowMs + 50) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

async function scheduleNextScheduleBoundary(settings, profile, nowMs) {
  const rules = profileRules(settings, 'scheduledRules', profile);
  let nextBoundary = Number.POSITIVE_INFINITY;

  for (const rule of rules) {
    // start === end is Focus Master's "always blocked" schedule, so it has no
    // meaningful daily transition to wake up for.
    if (clockMinutes(rule.startTime) === clockMinutes(rule.endTime)) continue;
    nextBoundary = Math.min(
      nextBoundary,
      nextLocalClockOccurrence(rule.startTime, nowMs),
      nextLocalClockOccurrence(rule.endTime, nowMs)
    );
  }

  try {
    await browser.alarms.clear(SCHEDULE_BOUNDARY_ALARM);
    if (Number.isFinite(nextBoundary)) {
      browser.alarms.create(SCHEDULE_BOUNDARY_ALARM, { when: nextBoundary + 25 });
    }
  } catch {}
}

async function scheduleQuotaDeadline(currentRules, nowMs) {
  if (!Array.isArray(currentRules) || !currentRules.length) {
    await clearDeadlineAlarm();
    return;
  }

  const usage = await readUsageState();
  let earliestRemaining = Number.POSITIVE_INFINITY;

  for (const descriptor of currentRules) {
    const rule = normalizeQuotaRule(descriptor);
    if (!rule) continue;
    const entry = normalizedUsageEntry(usage.entries[usageKey(rule)], rule, nowMs);
    const remaining = (rule.minutes * MINUTE_MS) - entry.usedMs;
    if (remaining <= 0) {
      earliestRemaining = 0;
      break;
    }
    earliestRemaining = Math.min(earliestRemaining, remaining);
  }

  if (!Number.isFinite(earliestRemaining)) {
    await clearDeadlineAlarm();
    return;
  }

  try {
    await browser.alarms.clear(DEADLINE_ALARM);
    browser.alarms.create(DEADLINE_ALARM, {
      when: nowMs + Math.max(DEADLINE_FLOOR_MS, earliestRemaining + 25)
    });
  } catch {}
}

let trackingStarted = false;
let samplingPromise = null;
let requestedSampleGeneration = 0;
let completedSampleGeneration = 0;
let contextProvider = null;
let activeTabCallback = null;

function isTwitchUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return host === 'twitch.tv' || host.endsWith('.twitch.tv');
  } catch {
    return false;
  }
}

async function runFocusedUsageSample() {
  const now = Date.now();
  const trackerRoot = await readTrackerState();
  const previous = trackerRoot[TRACKER_CONTEXT] && typeof trackerRoot[TRACKER_CONTEXT] === 'object'
    ? trackerRoot[TRACKER_CONTEXT]
    : null;

  // Commit only the interval that was known to belong to the previously focused
  // quota rule(s). The cap prevents a suspended browser/service worker from
  // charging hours of stale time after waking up.
  if (previous?.at && Array.isArray(previous.rules)) {
    const elapsed = Math.min(SAMPLE_CAP_MS, Math.max(0, now - Number(previous.at)));
    if (elapsed > 0) await addUsage(previous.rules, elapsed, now);
  }

  const context = await contextProvider();
  await scheduleNextScheduleBoundary(context?.settings, context?.profile, now);
  const tab = await focusedActiveTab();
  let currentRules = [];

  if (tab?.url && !isTwitchUrl(tab.url) && context?.settings?.enabled) {
    currentRules = profileRules(context.settings, 'quotaRules', context.profile)
      .filter(rule => linkMatches(tab.url, rule))
      .map(trackerRuleDescriptor);
  }

  trackerRoot[TRACKER_CONTEXT] = {
    at: now,
    tabId: tab?.id ?? null,
    url: tab?.url || '',
    rules: currentRules
  };
  await writeTrackerState(trackerRoot);

  // The exact quota deadline is the primary enforcement mechanism. If the tab
  // remains focused, this one-shot alarm wakes the MV3 worker at the moment the
  // remaining allowance should be exhausted. Tab/window changes reschedule it.
  await scheduleQuotaDeadline(currentRules, now);

  // Re-evaluate after committing usage, so a just-exhausted quota redirects the
  // active tab immediately rather than waiting for another navigation.
  if (tab?.url && !isTwitchUrl(tab.url) && typeof activeTabCallback === 'function') {
    try { await activeTabCallback(tab.id, tab.url); } catch {}
  }
}

function queueFocusedUsageSample() {
  if (!contextProvider) return Promise.resolve();

  requestedSampleGeneration += 1;
  if (!samplingPromise) {
    samplingPromise = (async () => {
      // Coalesce bursts, but never drop the newest state. If another request
      // lands while a sample is running, the loop performs one more full pass
      // before the shared promise resolves.
      while (completedSampleGeneration < requestedSampleGeneration) {
        const generation = requestedSampleGeneration;
        await runFocusedUsageSample();
        completedSampleGeneration = generation;
      }
    })().finally(() => {
      samplingPromise = null;
      // A request could theoretically land between the loop condition and the
      // finally block. Restart once if that happened.
      if (completedSampleGeneration < requestedSampleGeneration) {
        void queueFocusedUsageSample();
      }
    });
  }
  return samplingPromise;
}

// Exported so the service worker (and deterministic regression tests) can force
// a fresh accounting pass after settings/profile changes.
export function sampleTimeRuleUsageNow() {
  return queueFocusedUsageSample();
}

export function initializeTimeRuleTracking({ getContext, onActiveTabSample } = {}) {
  if (trackingStarted) return;
  trackingStarted = true;
  contextProvider = typeof getContext === 'function' ? getContext : null;
  activeTabCallback = typeof onActiveTabSample === 'function' ? onActiveTabSample : null;
  if (!contextProvider) return;

  try {
    // 30-second watchdog only. Exact blocking is handled by DEADLINE_ALARM.
    browser.alarms.create(USAGE_ALARM, { periodInMinutes: WATCHDOG_MINUTES });
    browser.alarms.onAlarm.addListener(alarm => {
      if (alarm?.name === USAGE_ALARM || alarm?.name === DEADLINE_ALARM || alarm?.name === SCHEDULE_BOUNDARY_ALARM) {
        void queueFocusedUsageSample();
      }
    });
  } catch {}

  try { browser.tabs.onActivated.addListener(() => void queueFocusedUsageSample()); } catch {}
  try {
    browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo?.url || changeInfo?.status === 'complete') void queueFocusedUsageSample();
    });
  } catch {}
  try { browser.windows.onFocusChanged.addListener(() => void queueFocusedUsageSample()); } catch {}
  try { browser.runtime.onStartup?.addListener(() => void queueFocusedUsageSample()); } catch {}
  try { browser.runtime.onInstalled?.addListener(() => void queueFocusedUsageSample()); } catch {}

  // Timer definitions and the active profile can change while the tracked tab
  // stays put. Resample immediately instead of waiting for the watchdog.
  try {
    browser.storage.onChanged.addListener((changes, areaName) => {
      const settingsChanged = areaName === 'sync' && Boolean(changes?.[STORAGE_KEYS.settings]);
      const localSettingsChanged = areaName === 'local' && Boolean(changes?.[STORAGE_KEYS.localSettings]);
      const profileChanged = areaName === 'local' && Boolean(changes?.[STORAGE_KEYS.localDataset]);
      if (settingsChanged || localSettingsChanged || profileChanged) void queueFocusedUsageSample();
    });
  } catch {}

  void queueFocusedUsageSample();
}
