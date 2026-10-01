/* Entry point for the built userscript. Not imported by tests. */
import { createLifecycle } from './lifecycle.js';
import { createUI } from './ui.js';

// Tampermonkey only defines GM_* when the metadata block grants them. A pasted
// copy that kept the editor's template header (`@grant none`) would otherwise
// crash here before drawing anything. Run degraded and say so in the pill.
const gm = (name) => (typeof globalThis[name] === 'function' ? globalThis[name] : null);
const GM_get = gm('GM_getValue');
const GM_set = gm('GM_setValue');
const GM_dl = gm('GM_download');
const missingGrants = ['GM_getValue', 'GM_setValue', 'GM_download'].filter((n) => !gm(n));

let lifecycle = null;

const ui = createUI({
  document,
  window,
  getValue: GM_get || (() => ''),
  setValue: GM_set || (() => {}),
  onSave: () => (lifecycle ? lifecycle.savePartial() : null),
  setTimeout: window.setTimeout.bind(window),
});

lifecycle = createLifecycle({
  window,
  document,
  location,
  MutationObserver,
  KeyboardEvent,
  GM_download: GM_dl || undefined,
  GM_setValue: GM_set || (() => {}),
  GM_getValue: GM_get || ((k, d) => d),
  Blob,
  URL,
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  getSettings: () => ({ myName: GM_get ? GM_get('MY_NAME', '') : '' }),
  onStatus: (status) => ui.update(status),
  onRecoverable: (found, api) => ui.offerRecovery(found, api),
  onError: (err) => {
    console.error('[meet-caption-capture]', err);
    ui.showError((err && err.message) || String(err));
  },
});

try {
  lifecycle.start();
} catch (err) {
  console.error('[meet-caption-capture]', err);
  ui.showError(`Failed to start: ${(err && err.message) || err}`);
}

if (missingGrants.length) {
  const msg = `Tampermonkey grants missing (${missingGrants.join(', ')}): reinstall from the raw GitHub URL. Captures still work; autosave and folders do not.`;
  console.error('[meet-caption-capture]', msg);
  ui.showError(msg, { sticky: true });
}
