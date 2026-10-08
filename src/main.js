/* Entry point for the built userscript. Not imported by tests. */
import { createLifecycle } from './lifecycle.js';
import { createUI } from './ui.js';

// Tampermonkey only defines GM_* when the metadata block grants them. A pasted
// copy that kept the editor's template header (`@grant none`) would otherwise
// crash here before drawing anything. Run degraded and say so in the pill.
// Tampermonkey injects GM_* as closure variables, not globals, so each must be
// probed by name with typeof (which is safe on an undeclared identifier).
/* global GM_getValue, GM_setValue, GM_download */
const GM_get = typeof GM_getValue === 'function' ? GM_getValue : null;
const GM_set = typeof GM_setValue === 'function' ? GM_setValue : null;
const GM_dl = typeof GM_download === 'function' ? GM_download : null;
const missingGrants = [
  ['GM_getValue', GM_get],
  ['GM_setValue', GM_set],
  ['GM_download', GM_dl],
].filter(([, fn]) => !fn).map(([name]) => name);

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
    console.error('[accessibility-turtle]', err);
    ui.showError((err && err.message) || String(err));
  },
});

try {
  lifecycle.start();
} catch (err) {
  console.error('[accessibility-turtle]', err);
  ui.showError(`Failed to start: ${(err && err.message) || err}`);
}

if (missingGrants.length) {
  const msg = `Tampermonkey grants missing (${missingGrants.join(', ')}): reinstall from the raw GitHub URL. Captions are still kept; autosave and folders do not work.`;
  console.error('[accessibility-turtle]', msg);
  ui.showError(msg, { sticky: true });
}
