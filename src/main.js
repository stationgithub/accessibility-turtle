/* Entry point for the built userscript. Not imported by tests. */
import { createLifecycle } from './lifecycle.js';

// Interim prompt until the phase 3 UI can offer recovery.
async function offerRecovery(found, { recover, discard }) {
  const n = found.length;
  const noun = n === 1 ? 'transcript' : 'transcripts';
  const ok = window.confirm(
    `Meet Caption Capture found ${n} unsaved ${noun} from an earlier call. Download ${n === 1 ? 'it' : 'them'} now?`,
  );
  for (const { key } of found) {
    if (!ok) discard(key);
    else await recover(key).catch((err) => console.error('[meet-caption-capture]', err));
  }
}

const lifecycle = createLifecycle({
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
  onRecoverable: offerRecovery,
  onError: (err) => console.error('[meet-caption-capture]', err),
});

lifecycle.start();
