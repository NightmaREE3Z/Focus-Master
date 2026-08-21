const params = new URLSearchParams(location.search);
const type = params.get('type') || 'unknown';
const trigger = String(params.get('trigger') || 'Ei tiedossa').trim();
const attempted = String(params.get('attempted') || '').trim();
const source = String(params.get('source') || '').trim();
const until = String(params.get('until') || '').trim();

const triggerLabel = document.querySelector('#triggerLabel');
const attemptedLabel = document.querySelector('#attemptedLabel');
const triggerValue = document.querySelector('#trigger');
const attemptedValue = document.querySelector('#attempted');
const sourceRow = document.querySelector('#sourceRow');
const sourceValue = document.querySelector('#source');
const blockedTitle = document.querySelector('#blockedTitle');
const blockedSubtitle = document.querySelector('#blockedSubtitle');
const blockedCard = document.querySelector('.blocked-card');
const scheduleClock = document.querySelector('#scheduleClock');
const clockHourHand = document.querySelector('#clockHourHand');
const clockMinuteHand = document.querySelector('#clockMinuteHand');
const clockSecondHand = document.querySelector('#clockSecondHand');
const quotaVisual = document.querySelector('#quotaVisual');

let liveClockFrame = 0;
let lastSpokenSecond = -1;

function buildClockFace() {
  if (!scheduleClock || scheduleClock.dataset.faceReady === '1') return;

  const tickFragment = document.createDocumentFragment();
  for (let index = 0; index < 60; index += 1) {
    const tickOrbit = document.createElement('span');
    tickOrbit.className = index % 5 === 0
      ? 'clock-tick-orbit clock-tick-major'
      : 'clock-tick-orbit';
    tickOrbit.setAttribute('aria-hidden', 'true');
    tickOrbit.style.transform = `rotate(${index * 6}deg)`;
    tickFragment.append(tickOrbit);
  }

  const numberFragment = document.createDocumentFragment();
  for (let number = 1; number <= 12; number += 1) {
    const orbit = document.createElement('span');
    orbit.className = 'clock-number-orbit';
    orbit.setAttribute('aria-hidden', 'true');
    orbit.style.transform = `rotate(${number * 30}deg)`;

    const label = document.createElement('span');
    label.className = 'clock-number';
    label.textContent = String(number);
    label.style.transform = `translateX(-50%) rotate(${-number * 30}deg)`;

    orbit.append(label);
    numberFragment.append(orbit);
  }

  scheduleClock.prepend(numberFragment);
  scheduleClock.prepend(tickFragment);
  scheduleClock.dataset.faceReady = '1';
}

function renderLiveClock() {
  if (!scheduleClock || !clockHourHand || !clockMinuteHand || !clockSecondHand) return;

  const now = new Date();
  const milliseconds = now.getMilliseconds();
  const seconds = now.getSeconds() + (milliseconds / 1000);
  const minutes = now.getMinutes() + (seconds / 60);
  const hours = (now.getHours() % 12) + (minutes / 60);

  clockSecondHand.style.transform = `rotate(${seconds * 6}deg)`;
  clockMinuteHand.style.transform = `rotate(${minutes * 6}deg)`;
  clockHourHand.style.transform = `rotate(${hours * 30}deg)`;

  const wholeSecond = now.getSeconds();
  if (wholeSecond !== lastSpokenSecond) {
    lastSpokenSecond = wholeSecond;
    const spokenTime = new Intl.DateTimeFormat('fi-FI', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(now);
    scheduleClock.setAttribute('aria-label', `Nykyinen aika ${spokenTime}`);
  }

  liveClockFrame = window.requestAnimationFrame(renderLiveClock);
}

function startLiveClock() {
  if (!scheduleClock) return;
  scheduleClock.hidden = false;
  buildClockFace();

  if (liveClockFrame) window.cancelAnimationFrame(liveClockFrame);
  liveClockFrame = window.requestAnimationFrame(renderLiveClock);
}


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

function validClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return `${match[1]}:${match[2]}`;
}

function enableSimpleTimePage(mode, title) {
  document.body.classList.add('simple-time-block', `${mode}-block`);
  blockedTitle.textContent = title;
  blockedSubtitle.hidden = true;
  blockedCard.hidden = true;
}

function setQuotaHeadingLayout() {
  if (!blockedTitle) return;
  blockedTitle.textContent = '';

  const lineOne = document.createElement('span');
  lineOne.className = 'quota-heading-line';
  lineOne.textContent = 'Sivusto estetty.';

  const lineTwo = document.createElement('span');
  lineTwo.className = 'quota-heading-line';
  lineTwo.textContent = 'Päivittäinen käyttöaika loppui.';

  blockedTitle.append(lineOne, lineTwo);
}

if (type === 'schedule') {
  const endTime = validClock(until);
  enableSimpleTimePage(
    'schedule',
    endTime ? `Sivusto estetty ${endTime} asti.` : 'Sivusto estetty määräajan.'
  );
  startLiveClock();
} else if (type === 'quota') {
  enableSimpleTimePage('quota', 'Sivusto estetty. Päivittäinen käyttöaika loppui.');
  setQuotaHeadingLayout();
  if (quotaVisual) quotaVisual.hidden = false;
}

if (type === 'link' || type === 'tld' || type === 'schedule' || type === 'quota' || type === 'unsupported') {
  triggerLabel.textContent = type === 'tld'
    ? 'ESTETTY TLD:'
    : type === 'schedule'
      ? 'AJASTETTU ESTO:'
      : type === 'quota'
        ? 'PÄIVÄRAJA TÄYNNÄ:'
        : type === 'unsupported'
          ? 'EI TUETTU SIVUSTO:'
          : 'ESTETTY SIVU:';
  attemptedLabel.textContent = type === 'schedule' || type === 'quota' ? 'SÄÄNTÖ:' : 'YRITETTY OSOITE:';
  sourceRow.hidden = true;
} else {
  triggerLabel.textContent = 'ESTETTY SANA:';
  attemptedLabel.textContent = 'YRITETTY HAKU:';
  sourceRow.hidden = false;
}

triggerValue.textContent = trigger;
appendHighlightedText(attemptedValue, attempted || ((type === 'link' || type === 'tld' || type === 'schedule' || type === 'quota' || type === 'unsupported') ? decodedForDisplay(source) : ''), trigger);
appendHighlightedText(sourceValue, decodedForDisplay(source), trigger);

window.addEventListener('pagehide', () => {
  if (liveClockFrame) {
    window.cancelAnimationFrame(liveClockFrame);
    liveClockFrame = 0;
  }
});

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
