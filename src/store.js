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
export function mergeCaptionText(previous, next) {
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

export function createStore({ now = () => Date.now(), mergeWindowMs = 2000 } = {}) {
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
