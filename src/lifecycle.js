/**
 * Call lifecycle: in-call detection, auto-captions, autosave, save-on-leave,
 * crash recovery. Pure: every browser API is injected so tests can drive it
 * with fakes and a manual clock.
 *
 * Selectors below have NOT been verified against a fixture yet (the Phase 1
 * fixture is a caption-region capture only). Anchored on aria-label prefixes,
 * never on generated class names. Verify on a real call before trusting them.
 */
import { createStore } from './store.js';
import { createWatcher } from './watcher.js';
import { writeTranscript } from './writer.js';

export const SELECTORS = {
  leaveButton: 'button[aria-label^="Leave call"]',
  captionsOnButton: 'button[aria-label^="Turn on captions"]',
  captionsOffButton: 'button[aria-label^="Turn off captions"]',
  title: '[data-meeting-title]',
  leftText: 'You left the meeting',
};

export const KEY_INDEX = 'mcc:sessions';
export const KEY_PREFIX = 'mcc:session:';

export function meetCodeFromPath(pathname) {
  const m = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i.exec(pathname || '');
  return m ? m[1].toLowerCase() : '';
}

function readJson(GM_getValue, key, fallback) {
  try {
    const raw = GM_getValue(key, null);
    if (raw == null) return fallback;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return fallback;
  }
}

export function createLifecycle({
  document,
  window,
  location = window && window.location,
  MutationObserver,
  KeyboardEvent,
  GM_download,
  GM_setValue,
  GM_getValue,
  Blob,
  URL,
  getSettings = () => ({}),
  onStatus = () => {},
  onRecoverable = () => {},
  onError = () => {},
  createWatcher: makeWatcher = createWatcher,
  createStore: makeStore = createStore,
  now = () => Date.now(),
  setInterval: repeat = globalThis.setInterval.bind(globalThis),
  clearInterval: stopRepeat = globalThis.clearInterval.bind(globalThis),
  setTimeout,
  clearTimeout,
  pollMs = 1000,
  autosaveMs = 30000,
  captionCheckMs = 15000,
  findRegionTimeoutMs = 20000,
  resumeAfterMs = 10000,
} = {}) {
  if (!document) throw new Error('createLifecycle requires document');
  if (!window) throw new Error('createLifecycle requires window');

  const downloadDeps = { GM_download, Blob, URL, document, setTimeout };

  let session = null;
  let awaitingExit = false;
  let exitAt = 0;
  let timers = [];
  let started = false;

  // ---- persistence -------------------------------------------------------

  const readIndex = () => {
    const list = readJson(GM_getValue, KEY_INDEX, []);
    return Array.isArray(list) ? list : [];
  };
  const writeIndex = (list) => GM_setValue(KEY_INDEX, JSON.stringify(list));

  function persist(s, turns, savedAt) {
    if (!turns.length) return;
    GM_setValue(
      s.key,
      JSON.stringify({
        v: 1,
        meetCode: s.meetCode,
        title: s.title,
        startedAt: s.startedAt,
        savedAt,
        captionLanguage: s.captionLanguage,
        turns,
      }),
    );
    const index = readIndex();
    if (!index.includes(s.key)) writeIndex([...index, s.key]);
  }

  function forget(key) {
    writeIndex(readIndex().filter((k) => k !== key));
    GM_setValue(key, null);
  }

  function snapshotTurns(s) {
    const live = s.store.getLive().map((e) => ({
      speaker: e.speaker,
      text: e.longestText || e.text,
      startedAt: e.startedAt,
    }));
    return [...s.store.getTurns(), ...live].sort((a, b) => a.startedAt - b.startedAt);
  }

  function sessionForWriter(s, turns, endedAt) {
    return {
      title: s.title,
      meetCode: s.meetCode,
      startedAt: s.startedAt,
      endedAt,
      captionLanguage: s.captionLanguage,
      turns,
    };
  }

  function writerOptions(partial) {
    const settings = getSettings() || {};
    return { partial, myName: settings.myName || '', transform: settings.transform || null };
  }

  // ---- detection ---------------------------------------------------------

  const isInCall = () => !!document.querySelector(SELECTORS.leaveButton);

  function hasLeftScreen() {
    const text = document.body && document.body.textContent;
    return !!text && text.includes(SELECTORS.leftText);
  }

  function refreshTitle(s) {
    const el = document.querySelector(SELECTORS.title);
    const value = el && (el.getAttribute
      ? el.getAttribute('data-meeting-title') || el.textContent
      : el.textContent);
    const title = String(value || '').trim();
    if (title) s.title = title;
  }

  // ---- captions ----------------------------------------------------------

  function typingInField() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || !!el.isContentEditable;
  }

  function ensureCaptions() {
    if (!session || session.regionState === 'capturing') return;
    const on = document.querySelector(SELECTORS.captionsOnButton);
    if (on) {
      on.click();
      return;
    }
    // "Turn off" means captions are already on; pressing `c` would switch them off.
    if (document.querySelector(SELECTORS.captionsOffButton)) return;
    if (typingInField() || !KeyboardEvent) return;
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true }),
    );
  }

  // ---- status ------------------------------------------------------------

  function getStatus() {
    if (!session) return { state: 'idle', elapsedMs: 0, lines: 0 };
    return {
      state: session.regionState,
      elapsedMs: now() - session.startedAt,
      lines: session.store.getTurns().length + session.store.getLive().length,
    };
  }

  const emitStatus = () => onStatus(getStatus());

  // ---- session -----------------------------------------------------------

  function beginSession() {
    const startedAt = now();
    const meetCode = meetCodeFromPath(location && location.pathname);
    const store = makeStore({ now });
    const s = {
      key: `${KEY_PREFIX}${meetCode || 'unknown'}:${startedAt}`,
      meetCode,
      startedAt,
      title: '',
      captionLanguage: 'en',
      store,
      watcher: null,
      regionState: 'waiting',
    };
    s.watcher = makeWatcher({
      document,
      MutationObserver,
      now,
      findRegionTimeoutMs,
      setTimeout,
      clearTimeout,
      onChange: ({ block, speaker, text }) => store.upsert(block, { speaker, text }),
      onRemove: ({ block }) => store.remove(block),
      onRegion: (region) => {
        if (region) s.regionState = 'capturing';
        else s.regionState = now() - s.startedAt >= findRegionTimeoutMs ? 'warning' : 'waiting';
        if (session === s) emitStatus();
      },
    });
    session = s;
    refreshTitle(s);
    s.watcher.start();
    ensureCaptions();
    emitStatus();
  }

  function autosave() {
    if (!session) return;
    persist(session, snapshotTurns(session), now());
  }

  /** Final save: exactly one download per call. */
  async function endSession() {
    const s = session;
    if (!s) return null;
    session = null;
    awaitingExit = true;
    exitAt = now();

    s.watcher.stop();
    refreshTitle(s);
    const endedAt = now();
    s.store.finalizeAll(endedAt);
    const turns = s.store.getTurns();
    emitStatus();

    if (!turns.length) {
      forget(s.key);
      return null;
    }

    // Persist first so a failed or interrupted download (beforeunload) is recoverable on next load.
    persist(s, turns, endedAt);
    try {
      const path = await writeTranscript(
        downloadDeps,
        sessionForWriter(s, turns, endedAt),
        writerOptions(false),
      );
      forget(s.key);
      return path;
    } catch (err) {
      onError(err);
      return null;
    }
  }

  /** Manual save: a `.partial.md` snapshot; the session keeps running. */
  async function savePartial() {
    if (!session) return null;
    refreshTitle(session);
    const turns = snapshotTurns(session);
    if (!turns.length) return null;
    try {
      return await writeTranscript(
        downloadDeps,
        sessionForWriter(session, turns, now()),
        writerOptions(true),
      );
    } catch (err) {
      onError(err);
      return null;
    }
  }

  // ---- recovery ----------------------------------------------------------

  function findRecoverable() {
    const found = [];
    for (const key of readIndex()) {
      const data = readJson(GM_getValue, key, null);
      if (data && Array.isArray(data.turns) && data.turns.length) found.push({ key, data });
    }
    return found;
  }

  async function recover(key) {
    const data = readJson(GM_getValue, key, null);
    if (!data || !Array.isArray(data.turns) || !data.turns.length) {
      forget(key);
      return null;
    }
    const path = await writeTranscript(
      downloadDeps,
      {
        title: data.title,
        meetCode: data.meetCode,
        startedAt: data.startedAt,
        endedAt: data.savedAt,
        captionLanguage: data.captionLanguage,
        turns: data.turns,
      },
      writerOptions(true),
    );
    forget(key);
    return path;
  }

  const discard = (key) => forget(key);

  // ---- wiring ------------------------------------------------------------

  function tick() {
    const inCall = isInCall();
    if (!inCall) awaitingExit = false;
    // A leave click that did not leave (e.g. a cancelled host dialog) must not
    // stop capture for the rest of the call: resume as a new session.
    else if (awaitingExit && now() - exitAt >= resumeAfterMs) awaitingExit = false;
    if (!session) {
      if (inCall && !awaitingExit) beginSession();
    } else if (!inCall && hasLeftScreen()) {
      endSession();
    } else {
      refreshTitle(session);
    }
    emitStatus();
  }

  function onClick(event) {
    const target = event && event.target;
    if (target && typeof target.closest === 'function' && target.closest(SELECTORS.leaveButton)) {
      endSession();
    }
  }

  function onBeforeUnload() {
    endSession();
  }

  function start() {
    if (started) return;
    started = true;
    const found = findRecoverable();
    if (found.length) onRecoverable(found, { recover, discard });
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    timers = [
      repeat(tick, pollMs),
      repeat(autosave, autosaveMs),
      repeat(ensureCaptions, captionCheckMs),
    ];
    tick();
  }

  function stop() {
    if (!started) return;
    started = false;
    for (const id of timers) stopRepeat(id);
    timers = [];
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (session) session.watcher.stop();
  }

  return {
    start,
    stop,
    tick,
    autosave,
    ensureCaptions,
    savePartial,
    finish: endSession,
    getStatus,
    findRecoverable,
    recover,
    discard,
  };
}
