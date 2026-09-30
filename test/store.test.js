import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, mergeCaptionText } from '../src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function blockKey(id, map) {
  if (!map.has(id)) map.set(id, { id });
  return map.get(id);
}

/**
 * Replay a fixture mutation log into the store.
 * Events may carry `speaker`/`text`, or a glued `blockText` ("You" + caption).
 */
function replayFixture(fixture, store) {
  const start = Date.parse(fixture.startedAt) || 0;
  const blocks = new Map();
  const defaultSpeaker = 'Speaker 1';

  for (const event of fixture.events) {
    const at = start + event.t;
    const block = blockKey(event.block, blocks);

    if (event.type === 'remove') {
      store.remove(block, at);
      continue;
    }

    let speaker = event.speaker || defaultSpeaker;
    let text = event.text || '';

    if (event.blockText) {
      // Local capture glued name+text without a separator ("You" + caption).
      const m = event.blockText.match(/^(You|Speaker \d+)([\s\S]*)/);
      if (m) {
        speaker = m[1];
        text = m[2];
      } else {
        text = event.blockText;
      }
    }

    if (event.type === 'characterData' || event.type === 'childList') {
      // childList without text is structural; only upsert when we have caption text
      if (text || event.blockText) {
        store.upsert(block, { speaker, text, at });
      }
    }
  }
}

describe('mergeCaptionText', () => {
  it('grows when next extends previous', () => {
    assert.equal(
      mergeCaptionText('hello world', 'hello world again'),
      'hello world again',
    );
  });

  it('keeps longestText when Meet trims the head and appends', () => {
    const prev = 'Alpha bravo charlie delta echo foxtrot';
    const next = 'bravo charlie delta echo foxtrot golf hotel';
    assert.equal(
      mergeCaptionText(prev, next),
      'Alpha bravo charlie delta echo foxtrot golf hotel',
    );
  });

  it('keeps longer form on a pure prefix shrink', () => {
    assert.equal(
      mergeCaptionText('hello world there', 'hello world'),
      'hello world there',
    );
  });
});

describe('createStore', () => {
  it('overwrites text on the same block and keeps longestText', () => {
    const store = createStore({ now: () => 0 });
    const block = {};
    store.upsert(block, { speaker: 'A', text: 'one two three', at: 0 });
    store.upsert(block, { speaker: 'A', text: 'one two', at: 10 });
    const live = store.getLive()[0];
    assert.equal(live.text, 'one two');
    assert.equal(live.longestText, 'one two three');
  });

  it('finalizes only on remove or finalizeAll', () => {
    const store = createStore({ now: () => 100 });
    const block = {};
    store.upsert(block, { speaker: 'A', text: 'hi', at: 0 });
    assert.equal(store.getTurns().length, 0);
    store.remove(block, 50);
    assert.equal(store.getTurns().length, 1);
    assert.equal(store.getTurns()[0].text, 'hi');
  });

  it('merges same speaker within 2s across two DOM blocks', () => {
    const store = createStore({ now: () => 0 });
    const a = { id: 1 };
    const b = { id: 2 };
    store.upsert(a, { speaker: 'Speaker 1', text: 'first part', at: 0 });
    store.remove(a, 500);
    store.upsert(b, { speaker: 'Speaker 1', text: 'second part', at: 1500 });
    store.finalizeAll(2000);
    const turns = store.getTurns();
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /first part/);
    assert.match(turns[0].text, /second part/);
  });

  it('does not merge same speaker after the 2s window', () => {
    const store = createStore({ now: () => 0 });
    const a = { id: 1 };
    const b = { id: 2 };
    store.upsert(a, { speaker: 'Speaker 1', text: 'first', at: 0 });
    store.remove(a, 100);
    store.upsert(b, { speaker: 'Speaker 1', text: 'later', at: 2500 });
    store.finalizeAll(3000);
    assert.equal(store.getTurns().length, 2);
  });
});

describe('fixture replay: scrubbed-head-trim-and-merge', () => {
  it('replays head-trim and same-speaker merge', () => {
    const fixture = loadJson('scrubbed-head-trim-and-merge.json');
    const store = createStore({ now: () => 0 });
    replayFixture(fixture, store);
    store.finalizeAll(Date.parse(fixture.startedAt) + 10_000);
    const turns = store.getTurns();

    assert.equal(turns.length, 2, 'Speaker 1 merged turn + Speaker 2');
    assert.equal(turns[0].speaker, 'Speaker 1');
    assert.equal(
      turns[0].text,
      'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
    );
    assert.equal(turns[1].speaker, 'Speaker 2');
    assert.equal(turns[1].text, 'Mike november oscar');
  });
});

describe('fixture replay: local solo capture (optional)', () => {
  const localName = '2026-09-30-solo.local.json';
  const localPath = path.join(fixturesDir, localName);
  const hasLocal = fs.existsSync(localPath);

  it(
    hasLocal
      ? 'replays the local solo fixture to one growing turn'
      : 'skips when local fixture is absent',
    { skip: !hasLocal },
    () => {
      const fixture = loadJson(localName);
      const store = createStore({ now: () => 0 });
      replayFixture(fixture, store);
      store.finalizeAll(Date.parse(fixture.startedAt) + 120_000);
      const turns = store.getTurns();
      assert.equal(turns.length, 1);
      assert.ok(
        turns[0].text.length >= 1300,
        `expected ~1363 chars, got ${turns[0].text.length}`,
      );
      // Must not leave raw speaker glue in assertions beyond peeling "You"
      assert.equal(turns[0].speaker, 'You');
    },
  );
});
