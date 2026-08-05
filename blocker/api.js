// Shared WebExtensions API namespace for Firefox and Chromium.
export const browser = globalThis.browser ?? globalThis.chrome;

if (!browser?.runtime) {
  throw new Error('WebExtensions runtime API is unavailable.');
}
