/* Entry point for the built userscript. Not imported by tests. */
import { createLifecycle } from './lifecycle.js';
import { createUI } from './ui.js';

let lifecycle = null;

const ui = createUI({
  document,
  window,
  getValue: GM_getValue,
  setValue: GM_setValue,
  onSave: () => (lifecycle ? lifecycle.savePartial() : null),
  setTimeout: window.setTimeout.bind(window),
});

lifecycle = createLifecycle({
  window,
  document,
  location,
  MutationObserver,
  KeyboardEvent,
  GM_download,
  GM_setValue,
  GM_getValue,
  Blob,
  URL,
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  getSettings: () => ({ myName: GM_getValue('MY_NAME', '') }),
  onStatus: (status) => ui.update(status),
  onRecoverable: (found, api) => ui.offerRecovery(found, api),
  onError: (err) => {
    console.error('[meet-caption-capture]', err);
    ui.showError((err && err.message) || String(err));
  },
});

lifecycle.start();
