// BraveFox Focus Master Time Rule pre-paint registration — 2026-08-21
//
// A document_start guard is registered only on sites that have a Scheduled
// block or Daily usage limit. It hides the page before first paint, asks the
// service worker for the authoritative Time Rule verdict, then either releases
// the page or leaves it covered while Focus Master redirects to blocked.html.

import { browser } from './api.js';

const SCRIPT_ID = 'bfb-time-rule-prepaint-v1';
const SCRIPT_FILE = 'blocker/time-rule-prepaint.js';

// Deterministic wrappers can expose a blocked Time Rule destination inside
// another URL. Register the pre-paint guard on those fixed wrapper hosts too,
// so Wayback/Jina/etc. do not reintroduce a visible-page glimpse.
const WRAPPER_MATCHES = Object.freeze([
  '*://web.archive.org/*',
  '*://*.archive-it.org/*',
  '*://r.jina.ai/*',
  '*://12ft.io/*',
  '*://webcache.googleusercontent.com/*',
  '*://arquivo.pt/*',
  '*://*.arquivo.pt/*',
  '*://timetravel.mementoweb.org/*',
  '*://*.mementoweb.org/*',
  '*://translate.google.com/*',
  '*://translate.google.fi/*',
  '*://translate.google.co.uk/*',
  '*://translate.google.de/*',
  '*://translate.google.fr/*',
  '*://translate.google.nl/*',
  '*://translate.google.com.br/*'
]);

function rawRuleHost(link) {
  let raw = String(link || '').trim().toLocaleLowerCase('en-US');
  if (!raw) return '';
  raw = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const authority = raw.split(/[/?#]/, 1)[0].replace(/:\d+$/, '');
  return authority.trim();
}

function isIpv4(host) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function matchPatternForHost(host) {
  const value = String(host || '').trim().toLocaleLowerCase('en-US');
  if (!value) return '';

  // A leading "*." is directly representable by Chrome match patterns.
  if (value.startsWith('*.') && !value.slice(2).includes('*')) {
    return `*://${value}/*`;
  }

  // Arbitrary host wildcards cannot be represented safely. Returning the
  // all-URLs pattern preserves the pre-paint guarantee; the authoritative
  // matcher in the service worker still decides whether the URL is blocked.
  if (value.includes('*')) return '<all_urls>';

  if (value === 'localhost' || isIpv4(value) || value.startsWith('[')) {
    return `*://${value}/*`;
  }

  // Chrome's *.example.com host pattern also covers example.com itself.
  return `*://*.${value}/*`;
}

export function timeRulePrepaintMatches(settings) {
  const rules = [
    ...(Array.isArray(settings?.scheduledRules) ? settings.scheduledRules : []),
    ...(Array.isArray(settings?.quotaRules) ? settings.quotaRules : [])
  ].filter(rule => rule && rule.enabled !== false && rule.link);

  if (!rules.length) return [];

  const matches = new Set();
  for (const rule of rules) {
    const pattern = matchPatternForHost(rawRuleHost(rule.link));
    if (pattern === '<all_urls>') return ['<all_urls>'];
    if (pattern) matches.add(pattern);
  }

  // Wrapper hosts are useful only when at least one Time Rule exists.
  for (const pattern of WRAPPER_MATCHES) matches.add(pattern);
  return [...matches];
}

let refreshPromise = null;
let queuedSettings = null;

async function applyRegistration(settings) {
  const scripting = browser.scripting;
  if (!scripting?.registerContentScripts || !scripting?.unregisterContentScripts) return false;

  const matches = timeRulePrepaintMatches(settings);

  // Unregister-before-register is deliberately idempotent and works when the
  // extension is upgraded/reloaded with an older persistent registration.
  try {
    await scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch {}

  if (!matches.length) return true;

  await scripting.registerContentScripts([{
    id: SCRIPT_ID,
    js: [SCRIPT_FILE],
    matches,
    excludeMatches: ['*://twitch.tv/*', '*://*.twitch.tv/*'],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true
  }]);
  return true;
}

export function refreshTimeRulePrepaintRegistration(settings) {
  queuedSettings = settings;

  if (!refreshPromise) {
    refreshPromise = (async () => {
      while (queuedSettings) {
        const next = queuedSettings;
        queuedSettings = null;
        try {
          await applyRegistration(next);
        } catch (error) {
          console.warn('[BraveFox Focus Master] Time Rule pre-paint registration failed:', error);
        }
      }
    })().finally(() => {
      refreshPromise = null;
      if (queuedSettings) void refreshTimeRulePrepaintRegistration(queuedSettings);
    });
  }

  return refreshPromise;
}
