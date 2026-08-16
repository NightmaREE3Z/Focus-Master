import {
  normalizeLinkForStorage,
  normalizeTerm,
  normalizeTldForStorage,
  uniqueInOrder
} from './shared.js';
import {
  normalizeTrustedSiteEntry,
  parseTrustedSitesCsv,
  serializeTrustedSitesCsv
} from './trusted-sites.js';

function normalizerFor(kind) {
  if (kind === 'links') return normalizeLinkForStorage;
  if (kind === 'tlds') return normalizeTldForStorage;
  if (kind === 'trustedSites') return normalizeTrustedSiteEntry;
  return normalizeTerm;
}

export function parseListText(text, kind) {
  if (kind === 'trustedSites') return parseTrustedSitesCsv(text).entries;

  const normalizer = normalizerFor(kind);
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('#'))
    .map(line => {
      // Firefox BlockSite exports one item per line. Its link importer also
      // tolerates semicolon-delimited rows, so keep only the first field.
      if (kind === 'links' && line.includes(';')) return line.split(';', 1)[0].trim();
      return line;
    });

  return uniqueInOrder(lines, normalizer);
}

export function serializeListCsv(values) {
  return `${(Array.isArray(values) ? values : []).join('\r\n')}\r\n`;
}

export function serializeListForKind(values, kind) {
  return kind === 'trustedSites' ? serializeTrustedSitesCsv(values) : serializeListCsv(values);
}

export function serializeFullBackup({ terms, links, tlds, trustedSites, settings }) {
  return JSON.stringify({
    format: 'bravefox-blocker-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    terms: Array.isArray(terms) ? terms : [],
    links: Array.isArray(links) ? links : [],
    tlds: Array.isArray(tlds) ? tlds : [],
    trustedSites: Array.isArray(trustedSites) ? trustedSites : [],
    settings: settings || {}
  }, null, 2);
}

export function parseFullBackup(text) {
  const parsed = JSON.parse(String(text ?? ''));
  if (!parsed || parsed.format !== 'bravefox-blocker-backup' || ![1, 2].includes(Number(parsed.version))) {
    throw new Error('This is not a supported BraveFox Focus Master backup.');
  }
  return {
    terms: uniqueInOrder(parsed.terms, normalizeTerm),
    links: uniqueInOrder(parsed.links, normalizeLinkForStorage),
    // Version 1 backups predate these lists. Null means “leave the current
    // list alone” so restoring an old backup cannot silently wipe newer rules.
    tlds: Array.isArray(parsed.tlds) ? uniqueInOrder(parsed.tlds, normalizeTldForStorage) : null,
    trustedSites: Array.isArray(parsed.trustedSites) ? uniqueInOrder(parsed.trustedSites, normalizeTrustedSiteEntry) : null,
    settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
  };
}
