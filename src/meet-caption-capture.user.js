// ==UserScript==
// @name         Meet Caption Capture
// @namespace    http://tampermonkey.net/
// @version      7.1.4
// @description  Captures Google Meet's on-screen live captions into a Markdown transcript. No audio, no network, no AI.
// @match        *://meet.google.com/*
// @updateURL    https://raw.githubusercontent.com/stationgithub/meet-caption-capture/main/src/meet-caption-capture.user.js
// @downloadURL  https://raw.githubusercontent.com/stationgithub/meet-caption-capture/main/src/meet-caption-capture.user.js
// @run-at       document-idle
// @noframes
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
'use strict';

// ---- store.js ----
/**
 * Pure caption store. No DOM globals — block identities are whatever the
 * watcher (or a test) passes in (DOM nodes in the page, plain objects in tests).
 *
 * Live entries: block -> { speaker, text, longestText, startedAt }
 * A block is finalized only on remove, or when save asks finalizeAll().
 */

/**
 * Merge Meet's evolving caption text.
 * Newest text usually wins, but when Meet trims the head of a long block while
 * appending to the tail, reconstruct via suffix/prefix overlap and keep the
 * longest coherent string.
 */
function mergeCaptionText(previous, next) {
  if (!previous) return next || '';
  if (!next) return previous;
  if (previous === next) return previous;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) {
    // Pure shrink / punctuation rewrite of a prefix — keep the longer form.
    return previous;
  }
  if (next.includes(previous)) return next;
  if (previous.endsWith(next)) return previous;

  // Head trim + tail growth: longest suffix of previous that is a prefix of next.
  const max = Math.min(previous.length, next.length);
  for (let n = max; n >= 1; n--) {
    if (previous.endsWith(next.slice(0, n))) {
      return previous + next.slice(n);
    }
  }

  // Overlap somewhere in the middle: keep previous prefix up to where next begins.
  for (let n = Math.min(previous.length, next.length); n >= 8; n--) {
    const tip = previous.slice(-n);
    const at = next.indexOf(tip);
    if (at !== -1) {
      return previous.slice(0, previous.length - n) + next.slice(at);
    }
  }

  return next;
}

function createStore({ now = () => Date.now(), mergeWindowMs = 2000 } = {}) {
  /** @type {WeakMap<object, object>} */
  const byBlock = new WeakMap();
  /** Live entries in insertion order (WeakMap is not iterable). */
  const live = [];
  /** Finalized turns. */
  const finalized = [];

  function touch(entry, speaker, text, at) {
    const merged = mergeCaptionText(entry.longestText || entry.text, text);
    entry.speaker = speaker;
    entry.text = text;
    if (merged.length >= (entry.longestText || '').length) {
      entry.longestText = merged;
    }
    entry.lastAt = at;
  }

  function findMergeCandidate(speaker, at) {
    for (let i = live.length - 1; i >= 0; i--) {
      const entry = live[i];
      if (entry.speaker === speaker && at - entry.startedAt <= mergeWindowMs) {
        return entry;
      }
    }
    for (let i = finalized.length - 1; i >= 0; i--) {
      const entry = finalized[i];
      if (entry.speaker === speaker && at - entry.startedAt <= mergeWindowMs) {
        finalized.splice(i, 1);
        entry.finalized = false;
        delete entry.endedAt;
        live.push(entry);
        return entry;
      }
    }
    return null;
  }

  function upsert(block, { speaker, text, at } = {}) {
    if (block == null) return null;
    const ts = at != null ? at : now();
    const name = speaker == null ? '' : String(speaker);
    const body = text == null ? '' : String(text);

    let entry = byBlock.get(block);
    if (entry) {
      touch(entry, name, body, ts);
      return entry;
    }

    const candidate = findMergeCandidate(name, ts);
    if (candidate) {
      byBlock.set(block, candidate);
      // New DOM node for the same turn (Meet split). Prefer overlap merge;
      // if the strings are disjoint, append rather than drop the earlier text.
      const merged = mergeCaptionText(candidate.longestText || candidate.text, body);
      if (
        body &&
        candidate.longestText &&
        merged === body &&
        !body.includes(candidate.longestText) &&
        !candidate.longestText.includes(body)
      ) {
        candidate.text = body;
        candidate.longestText = `${candidate.longestText} ${body}`.replace(/\s+/g, ' ').trim();
        candidate.lastAt = ts;
        candidate.speaker = name;
      } else {
        touch(candidate, name, body, ts);
      }
      return candidate;
    }

    entry = {
      speaker: name,
      text: body,
      longestText: body,
      startedAt: ts,
      lastAt: ts,
    };
    byBlock.set(block, entry);
    live.push(entry);
    return entry;
  }

  function remove(block, at) {
    const entry = byBlock.get(block);
    if (!entry) return null;
    const idx = live.indexOf(entry);
    if (idx !== -1) live.splice(idx, 1);
    if (!entry.finalized) {
      entry.finalized = true;
      entry.endedAt = at != null ? at : now();
      finalized.push(entry);
    }
    return entry;
  }

  function finalizeAll(at) {
    const ts = at != null ? at : now();
    while (live.length) {
      const entry = live.shift();
      if (!entry.finalized) {
        entry.finalized = true;
        entry.endedAt = ts;
        finalized.push(entry);
      }
    }
    return getTurns();
  }

  function getTurns() {
    return finalized
      .map((e) => ({
        speaker: e.speaker,
        text: e.longestText || e.text,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
      }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  function getLive() {
    return live.map((e) => ({
      speaker: e.speaker,
      text: e.text,
      longestText: e.longestText,
      startedAt: e.startedAt,
      lastAt: e.lastAt,
    }));
  }

  function getEntry(block) {
    return byBlock.get(block) || null;
  }

  return {
    upsert,
    remove,
    finalizeAll,
    getTurns,
    getLive,
    getEntry,
    mergeWindowMs,
  };
}

// ---- watcher.js ----
/**
 * Caption-region watcher. Pure: document, MutationObserver, and callbacks
 * are injected so tests can drive a fixture without a browser.
 *
 * Verified selectors (2026-09-30, solo English captions):
 * - Caption region: div[role="region"][aria-label="Captions"]
 *   (also accept [role="region"][aria-live] as a structural fallback)
 * - Observe ONLY that region's subtree.
 * - One caption block per speaker turn: a region child that has
 *     - an avatar img
 *     - a name element (span with the speaker label, e.g. "You")
 *     - a text element holding the caption (sibling of the name/avatar group)
 *   Meet class names (nMcdL, adE6rb, NWpY1d, ygicle) churn; do not match on them.
 * - Ignore region children with no name and no caption text (empty div,
 *   "Jump to bottom" button).
 */

const VERIFIED = {
  date: '2026-09-30',
  region: 'div[role="region"][aria-label="Captions"]',
  regionFallback: '[role="region"][aria-live]',
};

function findCaptionRegion(document) {
  if (!document || typeof document.querySelector !== 'function') return null;
  return (
    document.querySelector(VERIFIED.region) ||
    document.querySelector(VERIFIED.regionFallback) ||
    null
  );
}

/**
 * Structural parse of a caption block. Returns null if the element is not
 * a speaker turn (no name + text pair).
 */
function parseCaptionBlock(element) {
  if (!element || element.nodeType !== 1) return null;

  const img = element.querySelector && element.querySelector('img');
  if (!img) return null;

  // Name: first non-empty span that is not inside the caption text node we pick below.
  // Prefer a span that sits near the avatar (previous sibling group).
  const spans = element.querySelectorAll ? element.querySelectorAll('span') : [];
  let nameEl = null;
  for (const span of spans) {
    const t = (span.textContent || '').trim();
    if (!t) continue;
    // Skip spans that look like the whole caption (long).
    if (t.length > 80) continue;
    nameEl = span;
    break;
  }
  if (!nameEl) return null;

  // Caption text: a descendant div/element that contains text and is not the
  // avatar/name wrapper (the wrapper that contains the img).
  let textEl = null;
  const children = element.children || [];
  for (const child of children) {
    if (child.contains && child.contains(img)) continue;
    if (child.getAttribute && child.getAttribute('role') === 'button') continue;
    const t = (child.textContent || '').trim();
    if (t) {
      textEl = child;
      break;
    }
  }
  if (!textEl) return null;

  return {
    element,
    speaker: (nameEl.textContent || '').trim(),
    text: (textEl.textContent || '').trim(),
    nameEl,
    textEl,
  };
}

function listCaptionBlocks(region) {
  if (!region || !region.children) return [];
  const out = [];
  for (const child of region.children) {
    const parsed = parseCaptionBlock(child);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * @param {object} deps
 * @param {Document} deps.document
 * @param {typeof MutationObserver} deps.MutationObserver
 * @param {(info: {block: Element, speaker: string, text: string}) => void} deps.onChange
 * @param {(info: {block: Element}) => void} deps.onRemove
 * @param {(region: Element|null) => void} [deps.onRegion]
 * @param {number} [deps.findRegionTimeoutMs=20000]
 * @param {() => number} [deps.now]
 * @param {(fn: Function, ms: number) => any} [deps.setTimeout]
 * @param {(id: any) => void} [deps.clearTimeout]
 */
function createWatcher({
  document,
  MutationObserver,
  onChange,
  onRemove,
  onRegion,
  findRegionTimeoutMs = 20000,
  now = () => Date.now(),
  setTimeout: schedule = globalThis.setTimeout.bind(globalThis),
  clearTimeout: unschedule = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  if (!document) throw new Error('createWatcher requires document');
  if (!MutationObserver) throw new Error('createWatcher requires MutationObserver');
  if (typeof onChange !== 'function') throw new Error('createWatcher requires onChange');
  if (typeof onRemove !== 'function') throw new Error('createWatcher requires onRemove');

  let region = null;
  let observer = null;
  let pollId = null;
  let warnId = null;
  let startedAt = now();
  let regionFound = false;
  let stopped = false;
  /** @type {Set<Element>} */
  const known = new Set();

  function emitBlock(el) {
    const parsed = parseCaptionBlock(el);
    if (!parsed) return;
    known.add(el);
    onChange({
      block: el,
      speaker: parsed.speaker,
      text: parsed.text,
    });
  }

  function syncAll() {
    if (!region) return;
    const present = new Set();
    for (const parsed of listCaptionBlocks(region)) {
      present.add(parsed.element);
      emitBlock(parsed.element);
    }
    for (const el of [...known]) {
      if (!present.has(el)) {
        known.delete(el);
        onRemove({ block: el });
      }
    }
  }

  function onMutations() {
    syncAll();
  }

  function attach(next) {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    region = next;
    regionFound = !!next;
    if (typeof onRegion === 'function') onRegion(region);
    if (!region) return;
    if (warnId) {
      unschedule(warnId);
      warnId = null;
    }
    observer = new MutationObserver(onMutations);
    observer.observe(region, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    syncAll();
  }

  function lookForRegion() {
    if (stopped) return;
    const found = findCaptionRegion(document);
    if (found && found !== region) {
      attach(found);
    } else if (!found && region) {
      attach(null);
    }
  }

  function start() {
    stopped = false;
    startedAt = now();
    lookForRegion();
    pollId = schedule(function poll() {
      if (stopped) return;
      lookForRegion();
      pollId = schedule(poll, 500);
    }, 500);
    warnId = schedule(() => {
      if (!regionFound && typeof onRegion === 'function') {
        onRegion(null);
      }
    }, findRegionTimeoutMs);
  }

  function stop() {
    stopped = true;
    if (pollId) unschedule(pollId);
    if (warnId) unschedule(warnId);
    pollId = null;
    warnId = null;
    if (observer) observer.disconnect();
    observer = null;
  }

  return {
    start,
    stop,
    lookForRegion,
    getRegion: () => region,
    syncAll,
    VERIFIED,
  };
}

// ---- writer.js ----
/**
 * Transcript writer: filename, frontmatter, body, GM_download.
 * Pure except downloadMarkdown, whose browser APIs are injected.
 * All dates are rendered in the local timezone.
 */

const SCRIPT_VERSION = '7.1.4';
const DOWNLOAD_ROOT = 'Meet Transcripts';

const pad = (n) => String(n).padStart(2, '0');

function kebab(text, max = 60) {
  return String(text == null ? '' : text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

function durationMinutes(startedAt, endedAt) {
  return Math.max(1, Math.round((endedAt - startedAt) / 60000));
}

function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function displayTitle({ title, meetCode }) {
  return String(title || '').trim() || meetCode || 'meeting';
}

function buildFilename({ title, meetCode, startedAt, endedAt, partial = false }) {
  const d = new Date(startedAt);
  const stamp = `${formatDate(startedAt)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = kebab(title) || kebab(meetCode) || 'meeting';
  const minutes = durationMinutes(startedAt, endedAt);
  return `${stamp}.${slug}.${minutes}min${partial ? '.partial' : ''}.md`;
}

function buildPath(session, { partial = false } = {}) {
  const year = new Date(session.startedAt).getFullYear();
  return `${DOWNLOAD_ROOT}/${year}/${buildFilename({ ...session, partial })}`;
}

function displaySpeaker(speaker, myName) {
  const name = String(speaker || '').trim();
  const me = String(myName || '').trim();
  if (name === 'You' && me) return me;
  return name || 'Unknown';
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Prepare turns for output: resolve "You", apply the optional dictionary
 * transform, drop empty turns.
 */
function prepareTurns(turns, { myName = '', transform = null } = {}) {
  const out = [];
  for (const turn of turns || []) {
    let text = cleanText(turn.text);
    if (transform) text = cleanText(transform(text));
    if (!text) continue;
    out.push({ speaker: displaySpeaker(turn.speaker, myName), text });
  }
  return out;
}

function countWords(turns) {
  let n = 0;
  for (const turn of turns) {
    const words = turn.text.split(' ').filter(Boolean);
    n += words.length;
  }
  return n;
}

function buildBody(turns) {
  return turns.map((t) => `**${t.speaker}:** ${t.text}`).join('\n\n');
}

const yaml = (value) => JSON.stringify(String(value));

function buildFrontmatter(session, turns) {
  const speakers = [...new Set(turns.map((t) => t.speaker))];
  const lines = [
    '---',
    `date: ${formatDate(session.startedAt)}`,
    `start: ${yaml(formatTime(session.startedAt))}`,
    `end: ${yaml(formatTime(session.endedAt))}`,
    `duration_min: ${durationMinutes(session.startedAt, session.endedAt)}`,
    `title: ${yaml(displayTitle(session))}`,
    `meet_code: ${yaml(session.meetCode || '')}`,
    `speakers: [${speakers.map(yaml).join(', ')}]`,
    `word_count: ${countWords(turns)}`,
    `caption_language: ${yaml(session.captionLanguage || 'en')}`,
    `script_version: ${yaml(SCRIPT_VERSION)}`,
    '---',
  ];
  return lines.join('\n');
}

/**
 * @param {{title?: string, meetCode: string, startedAt: number, endedAt: number,
 *          captionLanguage?: string, turns: Array<{speaker: string, text: string}>}} session
 * @param {{myName?: string, transform?: ((text: string) => string) | null}} [options]
 */
function buildMarkdown(session, options = {}) {
  const turns = prepareTurns(session.turns, options);
  return `${buildFrontmatter(session, turns)}\n\n${buildBody(turns)}\n`;
}

/**
 * Plain browser download through an <a download> click, as v6 does. Browsers
 * cannot create folders this way, so only the file name is kept.
 */
function anchorDownload({ document }, url, path) {
  const name = path.split('/').pop();
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  (document.body || document.documentElement).appendChild(a);
  a.click();
  a.remove();
  return name;
}

/**
 * GM_download needs a URL, so the content goes through a blob URL.
 * Tampermonkey's download mode must be "Browser API" for the subfolder in `path`
 * to apply, and `.md` must be on its whitelisted extensions. If GM_download
 * errors (e.g. `not_whitelisted`) and a document is injected, fall back to a
 * plain browser download into the Downloads folder so the transcript is kept.
 */
function downloadMarkdown(deps, { path, content }) {
  const { GM_download, Blob, URL, document, setTimeout: later } = deps;
  return new Promise((resolve, reject) => {
    let url = null;
    let settled = false;
    const release = () => {
      if (url) URL.revokeObjectURL(url);
      url = null;
    };
    const fail = (why, { fallback = true } = {}) => {
      if (settled) return;
      settled = true;
      const detail = why && (why.error || why.details || why.message || why);
      if (fallback && url && document) {
        try {
          const name = anchorDownload(deps, url, path);
          // Revoking at once can cancel the browser download; give it time.
          const held = url;
          url = null;
          if (later) later(() => URL.revokeObjectURL(held), 60000);
          resolve(name);
          return;
        } catch {
          // fall through to the error below
        }
      }
      release();
      reject(new Error(`Download failed for ${path}: ${detail || 'unknown error'}`));
    };
    try {
      url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
      if (typeof GM_download !== 'function') throw new Error('GM_download unavailable');
      GM_download({
        url,
        name: path,
        saveAs: false,
        conflictAction: 'uniquify',
        onload: () => {
          if (settled) return;
          settled = true;
          release();
          resolve(path);
        },
        onerror: fail,
        // A timed-out download may still finish; falling back could save it twice.
        ontimeout: () => fail('timeout', { fallback: false }),
      });
    } catch (err) {
      fail(err);
    }
  });
}

function writeTranscript(deps, session, { partial = false, myName = '', transform = null } = {}) {
  const content = buildMarkdown(session, { myName, transform });
  const path = buildPath(session, { partial });
  return downloadMarkdown(deps, { path, content });
}

// ---- lifecycle.js ----
/**
 * Call lifecycle: in-call detection, auto-captions, autosave, save-on-leave,
 * crash recovery. Pure: every browser API is injected so tests can drive it
 * with fakes and a manual clock.
 *
 * Selectors below have NOT been verified against a fixture yet (the Phase 1
 * fixture is a caption-region capture only). Anchored on aria-label prefixes,
 * never on generated class names. Verify on a real call before trusting them.
 */

const SELECTORS = {
  leaveButton: 'button[aria-label^="Leave call"]',
  captionsOnButton: 'button[aria-label^="Turn on captions"]',
  captionsOffButton: 'button[aria-label^="Turn off captions"]',
  title: '[data-meeting-title]',
  leftText: 'You left the meeting',
};

const KEY_INDEX = 'mcc:sessions';
const KEY_PREFIX = 'mcc:session:';

function meetCodeFromPath(pathname) {
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

function createLifecycle({
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

// ---- ui.js ----
/**
 * Pill + settings panel. Pure: document, window, timers, and GM storage are
 * injected so tests can drive it with a fake DOM.
 *
 * DOM is built with createElement/textContent only: Meet enforces Trusted
 * Types, so innerHTML would throw.
 *
 * Layout rule: nothing rendered may sit in the bottom 120 px of the viewport
 * (Meet's toolbar lives there). The pill is pinned top right at a fixed height;
 * the drawer under it (settings, recovery) is capped by layoutFor().
 */

const UI = {
  top: 12,
  right: 12,
  pillHeight: 32,
  gap: 8,
  bottomReserve: 120,
  collapseBelow: 900,
  minDrawer: 48,
  zIndex: 2147483000,
};

const COLORS = {
  pill: '#f28b25',
  pillText: '#202124',
  dotRing: '#202124',
  grey: '#9aa0a6',
  orange: '#ff9800',
  red: '#ea4335',
};

/**
 * Where things go for a given viewport. Pure so the bottom-120 px rule can be
 * tested at any size.
 */
function layoutFor({ width, height, expanded = false }) {
  const collapsed = width < UI.collapseBelow && !expanded;
  const pillBottom = UI.top + UI.pillHeight;
  const limit = height - UI.bottomReserve;
  const drawerTop = pillBottom + UI.gap;
  const drawerMaxHeight = Math.max(0, limit - drawerTop);
  return {
    collapsed,
    hidden: pillBottom > limit,
    drawerTop,
    drawerMaxHeight,
    drawerHidden: drawerMaxHeight < UI.minDrawer,
    maxWidth: Math.max(0, width - 2 * UI.right),
  };
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Lifecycle status -> dot colour and a label that says what is going on. */
function statusView(status, errorText = '') {
  const state = (status && status.state) || 'idle';
  if (errorText) return { color: 'red', label: errorText };
  switch (state) {
    case 'capturing':
      return { color: 'orange', label: 'Capturing captions' };
    case 'warning':
      return { color: 'red', label: 'Captions not found. Turn on captions (c).' };
    case 'waiting':
      return { color: 'grey', label: 'Looking for captions…' };
    default:
      return { color: 'grey', label: 'Not in a call' };
  }
}

function createUI({
  document,
  window,
  getValue = () => '',
  setValue = () => {},
  onSave = async () => null,
  setTimeout: later = globalThis.setTimeout.bind(globalThis),
} = {}) {
  if (!document) throw new Error('createUI requires document');
  if (!window) throw new Error('createUI requires window');

  let status = { state: 'idle', elapsedMs: 0, lines: 0 };
  let errorText = '';
  /** A condition that outlives calls and saves (e.g. missing Tampermonkey grants). */
  let stickyError = '';
  let expanded = false;
  let settingsOpen = false;
  let saving = false;
  let saveNote = '';
  const recoveries = [];

  // ---- elements ----------------------------------------------------------

  function el(tag, role, style = {}, text) {
    const node = document.createElement(tag);
    node.setAttribute('data-mcc', role);
    Object.assign(node.style, style);
    if (text != null) node.textContent = text;
    return node;
  }

  const button = (role, text, style = {}) =>
    el('button', role, {
      font: 'inherit',
      border: 'none',
      borderRadius: '12px',
      padding: '0 10px',
      height: '24px',
      cursor: 'pointer',
      background: '#ffffff',
      color: COLORS.pillText,
      ...style,
    }, text);

  const root = el('div', 'root', {
    position: 'fixed',
    top: `${UI.top}px`,
    right: `${UI.right}px`,
    zIndex: String(UI.zIndex),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: `${UI.gap}px`,
    font: '500 13px/1 "Google Sans", Roboto, Arial, sans-serif',
    pointerEvents: 'none',
  });

  const pill = el('div', 'pill', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    boxSizing: 'border-box',
    height: `${UI.pillHeight}px`,
    padding: '0 4px',
    borderRadius: `${UI.pillHeight / 2}px`,
    background: COLORS.pill,
    color: COLORS.pillText,
    boxShadow: '0 1px 3px rgba(0,0,0,.3)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    pointerEvents: 'auto',
  });

  const dot = el('button', 'dot', {
    flex: '0 0 auto',
    width: '24px',
    height: '24px',
    padding: '0',
    border: 'none',
    borderRadius: '50%',
    background: COLORS.dotRing,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  });
  const dotInner = el('span', 'dot-inner', {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: COLORS.grey,
  });
  dot.appendChild(dotInner);

  const details = el('div', 'details', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: '0',
  });
  const message = el('span', 'message', { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' });
  const elapsed = el('span', 'elapsed', { fontVariantNumeric: 'tabular-nums' }, '0:00');
  const lines = el('span', 'lines', {}, '0 lines');
  const save = button('save', 'Save');
  const gear = button('settings-toggle', '⚙', { padding: '0', width: '24px', background: 'transparent' });
  gear.setAttribute('aria-label', 'Meet Caption Capture settings');
  gear.setAttribute('title', 'Settings');
  details.appendChild(message);
  details.appendChild(elapsed);
  details.appendChild(lines);
  details.appendChild(save);
  details.appendChild(gear);

  pill.appendChild(dot);
  pill.appendChild(details);

  const card = (role) =>
    el('div', role, {
      boxSizing: 'border-box',
      background: '#ffffff',
      color: COLORS.pillText,
      border: `2px solid ${COLORS.pill}`,
      borderRadius: '12px',
      padding: '12px',
      boxShadow: '0 1px 3px rgba(0,0,0,.3)',
      lineHeight: '1.4',
      pointerEvents: 'auto',
    });

  const drawer = el('div', 'drawer', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: `${UI.gap}px`,
    width: '300px',
    overflowY: 'auto',
    pointerEvents: 'none',
  });

  const recovery = card('recovery');
  const panel = card('panel');
  const nameLabel = el('label', 'name-label', { display: 'block', marginBottom: '6px' }, 'Your name (replaces "You")');
  const nameInput = el('input', 'name-input', {
    boxSizing: 'border-box',
    width: '100%',
    font: 'inherit',
    padding: '6px 8px',
    border: '1px solid #9aa0a6',
    borderRadius: '6px',
  });
  nameInput.setAttribute('type', 'text');
  nameInput.setAttribute('autocomplete', 'off');
  nameInput.setAttribute('aria-label', 'Your name (replaces "You")');
  nameInput.value = String(getValue('MY_NAME', '') || '');
  const nameNote = el('div', 'name-note', { marginTop: '6px', color: '#5f6368' });
  panel.appendChild(nameLabel);
  panel.appendChild(nameInput);
  panel.appendChild(nameNote);

  drawer.appendChild(recovery);
  drawer.appendChild(panel);
  root.appendChild(pill);
  root.appendChild(drawer);

  // ---- rendering ---------------------------------------------------------

  function mount() {
    const parent = document.body || document.documentElement;
    if (parent && !root.isConnected) parent.appendChild(root);
  }

  function render() {
    mount();
    const layout = layoutFor({ width: window.innerWidth, height: window.innerHeight, expanded });
    const view = statusView(status, errorText || stickyError);

    root.style.display = layout.hidden ? 'none' : 'flex';
    pill.style.maxWidth = `${layout.maxWidth}px`;
    details.style.display = layout.collapsed ? 'none' : 'flex';

    dotInner.style.background = COLORS[view.color];
    dot.setAttribute('data-color', view.color);
    dot.setAttribute('aria-label', `Meet Caption Capture: ${view.label}`);
    dot.setAttribute('title', view.label);

    const alert = view.color === 'red';
    message.textContent = alert ? view.label : '';
    message.style.display = alert ? 'inline' : 'none';
    message.style.color = alert ? '#8b0000' : 'inherit';
    elapsed.textContent = formatElapsed(status.elapsedMs);
    lines.textContent = `${status.lines || 0} ${status.lines === 1 ? 'line' : 'lines'}`;

    const inCall = status.state !== 'idle';
    save.disabled = saving || !inCall;
    save.textContent = saving ? 'Saving…' : saveNote || 'Save';
    save.style.opacity = save.disabled ? '0.6' : '1';

    const showRecovery = recoveries.length > 0;
    const showPanel = settingsOpen && !layout.collapsed;
    recovery.style.display = showRecovery ? 'block' : 'none';
    panel.style.display = showPanel ? 'block' : 'none';
    drawer.style.maxHeight = `${layout.drawerMaxHeight}px`;
    drawer.style.maxWidth = `${layout.maxWidth}px`;
    drawer.style.display = !layout.drawerHidden && (showRecovery || showPanel) ? 'flex' : 'none';
  }

  function renderRecovery() {
    while (recovery.firstChild) recovery.removeChild(recovery.firstChild);
    if (!recoveries.length) return;
    const n = recoveries.length;
    recovery.appendChild(
      el('div', 'recovery-title', { fontWeight: '700', marginBottom: '6px' },
        `Unsaved ${n === 1 ? 'transcript' : 'transcripts'} from an earlier call`),
    );
    for (const item of recoveries) {
      const row = el('div', 'recovery-row', {
        display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px',
      });
      const d = item.data || {};
      const when = d.startedAt ? new Date(d.startedAt) : null;
      const stamp = when
        ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
        : '';
      const name = d.title || d.meetCode || 'meeting';
      const turns = Array.isArray(d.turns) ? d.turns.length : 0;
      row.appendChild(el('span', 'recovery-label', { flex: '1 1 auto', minWidth: '0' },
        `${stamp} ${name}, ${turns} ${turns === 1 ? 'turn' : 'turns'}`.trim()));
      const get = button('recovery-download', 'Download', { background: COLORS.pill });
      const drop = button('recovery-discard', 'Discard', { background: '#e8eaed' });
      get.addEventListener('click', () => resolveRecovery(item, 'recover'));
      drop.addEventListener('click', () => resolveRecovery(item, 'discard'));
      row.appendChild(get);
      row.appendChild(drop);
      recovery.appendChild(row);
    }
  }

  async function resolveRecovery(item, action) {
    try {
      await item.api[action](item.key);
      const i = recoveries.indexOf(item);
      if (i !== -1) recoveries.splice(i, 1);
    } catch (err) {
      showError((err && err.message) || String(err));
    }
    renderRecovery();
    render();
  }

  // ---- events ------------------------------------------------------------

  dot.addEventListener('click', () => {
    if (window.innerWidth < UI.collapseBelow) expanded = !expanded;
    render();
  });

  gear.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    render();
  });

  save.addEventListener('click', async () => {
    if (saving) return;
    saving = true;
    saveNote = '';
    render();
    let result = null;
    try {
      result = await onSave();
    } catch (err) {
      showError((err && err.message) || String(err));
    }
    saving = false;
    if (result) {
      errorText = '';
      saveNote = 'Saved';
    } else if (!errorText) {
      saveNote = 'Nothing yet';
    }
    render();
    later(() => {
      saveNote = '';
      render();
    }, 2000);
  });

  function storeName() {
    const value = String(nameInput.value || '').trim();
    setValue('MY_NAME', value);
    nameNote.textContent = value ? `Saved. "You" will be written as ${value}.` : 'Saved. "You" stays "You".';
  }
  nameInput.addEventListener('change', storeName);
  // Keep keystrokes from reaching Meet's shortcuts (c toggles captions).
  for (const type of ['keydown', 'keyup', 'keypress']) {
    nameInput.addEventListener(type, (e) => e.stopPropagation());
  }

  const onResize = () => render();
  window.addEventListener('resize', onResize);

  // ---- API ---------------------------------------------------------------

  function update(next) {
    const joined = status.state === 'idle' && next && next.state && next.state !== 'idle';
    // An error from the previous call must not read as a warning in this one.
    if (joined) errorText = '';
    status = { ...status, ...(next || {}) };
    render();
  }

  function showError(text, { sticky = false } = {}) {
    const msg = String(text || 'Something went wrong');
    if (sticky) stickyError = msg;
    else errorText = msg;
    render();
  }

  function clearError() {
    errorText = '';
    stickyError = '';
    render();
  }

  /** Lifecycle onRecoverable hook: list unsaved sessions with Download / Discard. */
  function offerRecovery(found, api) {
    for (const f of found || []) {
      if (!recoveries.some((r) => r.key === f.key)) recoveries.push({ key: f.key, data: f.data, api });
    }
    renderRecovery();
    render();
  }

  function destroy() {
    window.removeEventListener('resize', onResize);
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  render();

  return { update, showError, clearError, offerRecovery, destroy, render, root };
}

// ---- main.js ----
/* Entry point for the built userscript. Not imported by tests. */

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
})();
