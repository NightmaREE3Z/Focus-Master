import { browser } from './api.js';
import { MESSAGE } from './constants.js';

const form = document.querySelector('#unlockForm');
const input = document.querySelector('#passwordInput');
const button = document.querySelector('#unlockButton');
const errorText = document.querySelector('#errorText');
const panel = document.querySelector('.lock-panel');
const popupTitle = document.querySelector('#popupTitle');
const subtitle = document.querySelector('.subtitle');
const hint = document.querySelector('.hint');
const quickBlockButton = document.querySelector('#openQuickBlock');
const inIncognito = Boolean(browser.extension?.inIncognitoContext);

const manifest = browser.runtime.getManifest();
const installedVersion = manifest.version;
const extensionName = manifest.name || 'BraveFox Focus Master';

const versionLabel = document.querySelector('#enhancerVersion');
if (versionLabel) {
  versionLabel.textContent = `${extensionName} v${installedVersion}`;
}

const updateButton = document.querySelector('#checkExtensionUpdate');

function requestChromiumUpdateCheck() {
  return new Promise((resolve, reject) => {
    if (typeof browser.runtime.requestUpdateCheck !== 'function') {
      reject(new Error('This Chromium build does not expose manual extension update checks.'));
      return;
    }

    let settled = false;

    const resolveOnce = (resultOrStatus, details = undefined) => {
      if (settled) return;
      settled = true;

      const runtimeError = browser.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      const result = typeof resultOrStatus === 'string'
        ? { status: resultOrStatus, ...(details || {}) }
        : resultOrStatus;
      resolve(result || { status: 'no_update' });
    };

    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    try {
      const maybePromise = browser.runtime.requestUpdateCheck(resolveOnce);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolveOnce, rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

if (updateButton) {
  updateButton.addEventListener('click', async () => {
    updateButton.disabled = true;
    updateButton.textContent = 'Checking for updates…';

    try {
      const result = await requestChromiumUpdateCheck();
      const resultStatus = result?.status || 'no_update';

      if (resultStatus === 'update_available') {
        updateButton.textContent = result?.version
          ? `Update ${result.version} found`
          : 'Update found';
        return;
      }

      if (resultStatus === 'throttled') {
        updateButton.textContent = 'Try again later';
        return;
      }

      updateButton.textContent = 'Up to date';
    } catch (updateError) {
      console.warn('BraveFox Focus Master update check failed:', updateError);
      updateButton.textContent = 'Check again';
    } finally {
      updateButton.disabled = false;
    }
  });
}

async function send(payload) {
  const response = await browser.runtime.sendMessage(payload);
  if (!response?.ok) {
    throw new Error(response?.error || 'BraveFox Focus Master request failed.');
  }
  return response;
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

if (!inIncognito) form.addEventListener('submit', async event => {
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
    if (document.body.dataset.bravefoxLauncher === 'options') {
      errorText.textContent = 'Manager opened.';
      input.value = '';
    } else {
      window.close();
    }
  } catch (error) {
    shake(error.message);
  } finally {
    button.disabled = false;
    input.disabled = false;
  }
});

if (quickBlockButton && !inIncognito) {
  quickBlockButton.addEventListener('click', async () => {
    try {
      await browser.runtime.openOptionsPage();
      window.close();
    } catch (error) {
      shake(String(error?.message || error));
    }
  });
}

if (inIncognito) {
  if (popupTitle) popupTitle.textContent = 'Management unavailable in Incognito';
  if (subtitle) subtitle.textContent = 'Blocking remains active.';
  if (form) form.hidden = true;
  if (quickBlockButton) quickBlockButton.hidden = true;
  if (hint) hint.textContent = 'Open BraveFox Focus Master from a normal Chrome window to manage settings.';
} else {
  setTimeout(() => input.focus(), 0);
}
