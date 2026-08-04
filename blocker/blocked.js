const params = new URLSearchParams(location.search);
const type = params.get('type') || 'unknown';
const trigger = String(params.get('trigger') || 'Ei tiedossa').trim();
const attempted = String(params.get('attempted') || '').trim();
const source = String(params.get('source') || '').trim();

const triggerLabel = document.querySelector('#triggerLabel');
const attemptedLabel = document.querySelector('#attemptedLabel');
const triggerValue = document.querySelector('#trigger');
const attemptedValue = document.querySelector('#attempted');
const sourceRow = document.querySelector('#sourceRow');
const sourceValue = document.querySelector('#source');

function decodedForDisplay(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function highlightTokens(needle) {
  const seen = new Set();
  return String(needle || '')
    .trim()
    .split(/\s+/u)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => {
      const key = token.toLocaleLowerCase('fi-FI');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.length - a.length);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendHighlightedText(target, text, needle) {
  target.replaceChildren();
  const value = String(text || '').trim();
  const tokens = highlightTokens(needle);
  if (!value) {
    target.textContent = 'Ei tiedossa';
    return;
  }
  if (!tokens.length) {
    target.textContent = value;
    return;
  }

  let matcher;
  try {
    matcher = new RegExp(tokens.map(escapeRegExp).join('|'), 'giu');
  } catch {
    target.textContent = value;
    return;
  }

  let cursor = 0;
  let match;
  let found = false;
  while ((match = matcher.exec(value)) !== null) {
    found = true;
    if (match.index > cursor) {
      target.append(document.createTextNode(value.slice(cursor, match.index)));
    }
    const mark = document.createElement('mark');
    mark.className = 'trigger-highlight';
    mark.textContent = match[0];
    target.append(mark);
    cursor = match.index + match[0].length;
    if (!match[0].length) matcher.lastIndex += 1;
  }

  if (!found) {
    target.textContent = value;
    return;
  }
  if (cursor < value.length) target.append(document.createTextNode(value.slice(cursor)));
}

if (type === 'link') {
  triggerLabel.textContent = 'ESTETTY SIVU:';
  attemptedLabel.textContent = 'YRITETTY OSOITE:';
  sourceRow.hidden = true;
} else {
  triggerLabel.textContent = 'ESTETTY SANA:';
  attemptedLabel.textContent = 'YRITETTY HAKU:';
  sourceRow.hidden = false;
}

triggerValue.textContent = trigger;
appendHighlightedText(attemptedValue, attempted || (type === 'link' ? decodedForDisplay(source) : ''), trigger);
appendHighlightedText(sourceValue, decodedForDisplay(source), trigger);

document.querySelector('#closeButton').addEventListener('click', async () => {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {}
  try { window.close(); } catch {}
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') document.querySelector('#closeButton').click();
});
