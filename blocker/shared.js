import { isTrustedHostname, isTrustedUrl } from './trusted-sites.js';

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function safeDecode(value) {
  let output = String(value ?? '');
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(output.replace(/\+/g, ' '));
      if (decoded === output) break;
      output = decoded;
    } catch {
      break;
    }
  }
  return output;
}

export function normalizeSearchable(value) {
  return normalizeWhitespace(
    safeDecode(value)
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\/_|.,:;!?&=+%#@()[\]{}<>"'`~\\-]+/g, ' ')
  );
}

export function normalizeTerm(value) {
  return normalizeWhitespace(
    String(value ?? '')
      .replace(/^\uFEFF/, '')
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
  );
}

export function normalizeLinkForStorage(value) {
  const raw = normalizeWhitespace(value).replace(/^\uFEFF/, '');
  if (!raw) return '';

  if (raw.includes('*')) {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/$/, '')
      .toLocaleLowerCase('en-US');
  }

  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    const host = parsed.hostname.toLocaleLowerCase('en-US').replace(/^www\./, '').replace(/\.$/, '');
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    const query = parsed.search || '';
    return `${host}${path}${query}`;
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/$/, '')
      .toLocaleLowerCase('en-US');
  }
}

export function normalizeTldForStorage(value) {
  let raw = normalizeWhitespace(value).replace(/^\uFEFF/, '').toLocaleLowerCase('en-US');
  if (!raw) return '';

  // Accept friendly forms such as .ai, ai, *.ai and multi-label suffixes such
  // as .co.uk. TLD rules are suffix rules only; paths, queries and ports are
  // deliberately rejected rather than guessed.
  raw = raw.replace(/^\*\./, '.').replace(/^\.+/, '');
  if (!raw || /[\s\/?#:@]/.test(raw) || raw.includes('..')) return '';
  const labels = raw.split('.');
  if (labels.some(label => !label)) return '';
  return `.${raw}`;
}

export function normalizeRedirectUrl(value) {
  const raw = normalizeWhitespace(value).replace(/^\uFEFF/, '');
  if (!raw) return '';

  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function uniqueInOrder(values, normalizer) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizer(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

// Compatibility alias for early Blocker builds. It deliberately preserves
// insertion/import order as of v0.1.5 instead of alphabetically sorting.
export const uniqueSorted = uniqueInOrder;

export function isSupportedWebUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const isCompletelyExcludedHostname = isTrustedHostname;
export const isCompletelyExcludedUrl = isTrustedUrl;

export function isIncognitoSender(sender) {
  return Boolean(
    chrome.extension?.inIncognitoContext ||
    sender?.tab?.incognito
  );
}

export function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
