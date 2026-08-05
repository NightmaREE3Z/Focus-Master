import { browser } from './api.js';
import { MESSAGE } from './constants.js';
import { normalizeLinkForStorage, normalizeTerm } from './shared.js';

const toggle = document.querySelector('#quickToggle');
const panel = document.querySelector('#quickPanel');
const form = document.querySelector('#quickForm');
const input = document.querySelector('#quickInput');
const submit = document.querySelector('#quickSubmit');
const label = document.querySelector('#quickLabel');
const help = document.querySelector('#quickHelp');
const status = document.querySelector('#quickStatus');
const kindButtons = [...document.querySelectorAll('.kind-button')];

let kind = 'terms';

function showStatus(message, state = 'ok') {
  status.textContent = message;
  status.dataset.state = state;
}

function setKind(nextKind) {
  kind = nextKind === 'links' ? 'links' : 'terms';
  for (const button of kindButtons) {
    button.setAttribute('aria-selected', String(button.dataset.kind === kind));
  }

  if (kind === 'links') {
    label.textContent = 'Link to block';
    input.placeholder = 'example.com or example.com/path';
    input.inputMode = 'url';
    help.textContent = 'The link is normalized and appended to the blocked-links list.';
  } else {
    label.textContent = 'Term to block';
    input.placeholder = 'Enter a word or phrase';
    input.inputMode = 'text';
    help.textContent = 'The term is normalized and appended to the blocked-terms list.';
  }

  showStatus('');
  input.focus();
}

toggle.addEventListener('click', () => {
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!expanded));
  panel.hidden = expanded;
  if (!expanded) setTimeout(() => input.focus(), 0);
});

for (const button of kindButtons) {
  button.addEventListener('click', () => setKind(button.dataset.kind));
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  showStatus('');

  const normalize = kind === 'links' ? normalizeLinkForStorage : normalizeTerm;
  const value = normalize(input.value);
  if (!value) {
    showStatus(kind === 'links' ? 'Enter a valid link first.' : 'Enter a valid term first.', 'error');
    input.focus();
    return;
  }

  submit.disabled = true;
  input.disabled = true;
  submit.textContent = 'Adding…';

  try {
    const response = await browser.runtime.sendMessage({
      type: MESSAGE.quickAddItem,
      kind,
      value
    });
    if (!response?.ok) throw new Error(response?.error || 'Quick Block request failed.');

    const itemName = kind === 'links' ? 'link' : 'term';
    if (response.changed) {
      showStatus(`Added ${itemName}: ${response.value}`);
      input.value = '';
    } else {
      showStatus(`That ${itemName} is already blocked.`);
      input.select();
    }
  } catch (error) {
    showStatus(String(error?.message || error), 'error');
  } finally {
    submit.disabled = false;
    input.disabled = false;
    submit.textContent = 'Add';
    input.focus();
  }
});
