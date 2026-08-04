import { normalizeLinkForStorage, normalizeTerm, uniqueInOrder } from './shared.js';

export function parseListText(text, kind) {
  const normalizer = kind === 'links' ? normalizeLinkForStorage : normalizeTerm;
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
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

export function serializeFullBackup({ terms, links, settings }) {
  return JSON.stringify({
    format: 'bravefox-blocker-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    terms: Array.isArray(terms) ? terms : [],
    links: Array.isArray(links) ? links : [],
    settings: settings || {}
  }, null, 2);
}

export function parseFullBackup(text) {
  const parsed = JSON.parse(String(text ?? ''));
  if (!parsed || parsed.format !== 'bravefox-blocker-backup' || parsed.version !== 1) {
    throw new Error('This is not a supported BraveFox Focus Master backup.');
  }
  return {
    terms: uniqueInOrder(parsed.terms, normalizeTerm),
    links: uniqueInOrder(parsed.links, normalizeLinkForStorage),
    settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
  };
}
