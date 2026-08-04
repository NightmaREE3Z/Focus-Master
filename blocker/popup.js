import { MESSAGE } from './constants.js';

const form = document.querySelector('#unlockForm');
const input = document.querySelector('#passwordInput');
const button = document.querySelector('#unlockButton');
const errorText = document.querySelector('#errorText');
const panel = document.querySelector('.lock-panel');

function send(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'BraveFox Focus Master request failed.'));
        return;
      }
      resolve(response);
    });
  });
}

function shake(message) {
  errorText.textContent = message;
  panel.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(6px)' },
      { transform: 'translateX(0)' }
    ],
    { duration: 180 }
  );
  input.focus();
  input.select();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  errorText.textContent = '';
  button.disabled = true;
  input.disabled = true;

  try {
    const response = await send({
      type: MESSAGE.popupUnlockOpen,
      password: input.value
    });
    if (!response.unlocked) {
      shake('Incorrect password. Try again.');
      return;
    }
    window.close();
  } catch (error) {
    shake(error.message);
  } finally {
    button.disabled = false;
    input.disabled = false;
  }
});

setTimeout(() => input.focus(), 0);
