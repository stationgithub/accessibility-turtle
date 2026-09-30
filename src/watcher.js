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

export const VERIFIED = {
  date: '2026-09-30',
  region: 'div[role="region"][aria-label="Captions"]',
  regionFallback: '[role="region"][aria-live]',
};

export function findCaptionRegion(document) {
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
export function parseCaptionBlock(element) {
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

export function listCaptionBlocks(region) {
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
export function createWatcher({
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
