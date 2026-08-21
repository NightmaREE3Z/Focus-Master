// BraveFox Focus Master Time Rule pre-paint guard — 2026-08-21
//
// This is intentionally a classic content script (not an ES module), because
// chrome.scripting.registerContentScripts() executes it at document_start.

(() => {
  if (!/^https?:$/i.test(location.protocol)) return;

  const MESSAGE_TYPE = 'BFB_TIME_RULE_PREPAINT_CHECK';
  const STYLE_ID = 'bfb-time-rule-prepaint-shield';
  let generation = 0;
  let shield = null;

  function ensureShield() {
    if (shield?.isConnected) return;

    shield = document.createElement('style');
    shield.id = STYLE_ID;
    shield.textContent = `
      html {
        background: #0b4b63 !important;
      }
      body {
        visibility: hidden !important;
      }
    `;

    const parent = document.head || document.documentElement;
    if (parent) parent.appendChild(shield);
  }

  function releaseShield(expectedGeneration) {
    if (expectedGeneration !== generation) return;
    try { shield?.remove(); } catch {}
    shield = null;
  }

  function checkUrl(urlValue) {
    const url = String(urlValue || location.href || '');
    if (!/^https?:\/\//i.test(url)) return;

    generation += 1;
    const currentGeneration = generation;
    ensureShield();

    // The background owns the actual Time Rule decision. The content script
    // remains fail-closed only while that decision is in flight.
    try {
      chrome.runtime.sendMessage(
        { type: MESSAGE_TYPE, url },
        response => {
          if (currentGeneration !== generation) return;

          if (chrome.runtime.lastError || !response?.ok || response?.blocked !== true) {
            releaseShield(currentGeneration);
            return;
          }

          // When blocked, leave the shield in place. The service worker is
          // already replacing this tab with Focus Master's blocked page.
        }
      );
    } catch {
      releaseShield(currentGeneration);
    }
  }

  // Initial navigation: shield before the page receives its first paint.
  checkUrl(location.href);

  // Chrome's Navigation API catches same-document pushState/replaceState/
  // back/forward navigations before they settle. This keeps SPA sub-pages from
  // becoming a timing loophole on configured Time Rule sites.
  try {
    if (globalThis.navigation?.addEventListener) {
      globalThis.navigation.addEventListener('navigate', event => {
        const destination = event?.destination?.url;
        if (destination && destination !== location.href) checkUrl(destination);
      });
    } else {
      addEventListener('popstate', () => checkUrl(location.href), true);
      addEventListener('hashchange', () => checkUrl(location.href), true);
    }
  } catch {}
})();
