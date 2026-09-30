import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERIFIED,
  findCaptionRegion,
  parseCaptionBlock,
  listCaptionBlocks,
  createWatcher,
} from '../src/watcher.js';

/** Minimal DOM stubs — no jsdom dependency. */
function el(tag, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    children: [],
    childNodes: [],
    parentNode: null,
    textContent: attrs.textContent || '',
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      this.childNodes.push(child);
      return child;
    },
    contains(other) {
      if (other === this) return true;
      for (const c of this.children) {
        if (c === other || (c.contains && c.contains(other))) return true;
      }
      return false;
    },
    querySelector(sel) {
      return queryAll(this, sel)[0] || null;
    },
    querySelectorAll(sel) {
      return queryAll(this, sel);
    },
  };
  for (const c of children) node.appendChild(c);
  refreshText(node);
  return node;
}

function refreshText(node) {
  if (!node.children || node.children.length === 0) return;
  node.textContent = node.children.map((c) => c.textContent || '').join('');
}

function queryAll(root, sel) {
  const out = [];
  walk(root, (n) => {
    if (n === root) return;
    if (matches(n, sel)) out.push(n);
  });
  return out;
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

function matches(node, sel) {
  if (sel === 'img') return node.tagName === 'IMG';
  if (sel === 'span') return node.tagName === 'SPAN';
  if (sel === 'div') return node.tagName === 'DIV';
  // div[role="region"][aria-label="Captions"]
  const re = /^([a-z0-9]+)((?:\[[^\]]+\])*)$/i;
  const m = sel.match(re);
  if (!m) return false;
  if (m[1].toUpperCase() !== node.tagName) return false;
  const attrs = [...m[2].matchAll(/\[([^=\]]+)(?:=\"([^\"]*)\")?\]/g)];
  for (const [, name, value] of attrs) {
    const got = node.getAttribute(name);
    if (value === undefined) {
      if (got == null) return false;
    } else if (got !== value) {
      return false;
    }
  }
  return true;
}

function captionBlock(speaker, text) {
  const name = el('span', { textContent: speaker });
  const avatarWrap = el('div', {}, [
    el('img', { alt: '', src: 'AVATAR' }),
    el('div', {}, [name]),
  ]);
  const textEl = el('div', { textContent: text });
  return el('div', {}, [avatarWrap, textEl]);
}

function makeDocument(regionChildren = []) {
  const region = el(
    'div',
    { role: 'region', 'aria-label': 'Captions' },
    regionChildren,
  );
  // junk siblings Meet includes
  region.appendChild(el('div', {}));
  region.appendChild(el('button', { role: 'button', textContent: 'Jump to bottom' }));

  const body = el('div', {}, [region]);
  return {
    region,
    body,
    document: {
      querySelector(sel) {
        return body.querySelector(sel);
      },
      querySelectorAll(sel) {
        return body.querySelectorAll(sel);
      },
    },
  };
}

class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb;
    this.target = null;
  }
  observe(target) {
    this.target = target;
  }
  disconnect() {
    this.target = null;
  }
  /** test helper */
  fire() {
    this.cb([]);
  }
}

describe('watcher selectors', () => {
  it('records verified selectors dated 2026-09-30', () => {
    assert.equal(VERIFIED.date, '2026-09-30');
    assert.equal(VERIFIED.region, 'div[role="region"][aria-label="Captions"]');
  });

  it('finds the caption region by role + aria-label', () => {
    const { document, region } = makeDocument();
    assert.equal(findCaptionRegion(document), region);
  });

  it('parses a block by structure (avatar + name + text), not class names', () => {
    const block = captionBlock('Speaker 1', 'Hello from captions');
    const parsed = parseCaptionBlock(block);
    assert.ok(parsed);
    assert.equal(parsed.speaker, 'Speaker 1');
    assert.equal(parsed.text, 'Hello from captions');
  });

  it('ignores region children without name+text structure', () => {
    const { region } = makeDocument([captionBlock('You', 'Hi')]);
    const blocks = listCaptionBlocks(region);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].speaker, 'You');
  });
});

describe('createWatcher', () => {
  it('observes only the caption region and emits change/remove', () => {
    const changes = [];
    const removes = [];
    const block = captionBlock('Speaker 1', 'one');
    const { document, region } = makeDocument([block]);

    let observerInstance = null;
    function MO(cb) {
      observerInstance = new FakeMutationObserver(cb);
      return observerInstance;
    }

    const watcher = createWatcher({
      document,
      MutationObserver: MO,
      onChange: (info) => changes.push(info),
      onRemove: (info) => removes.push(info),
      setTimeout: (fn) => 1,
      clearTimeout: () => {},
      findRegionTimeoutMs: 20_000,
    });

    watcher.start();
    assert.equal(watcher.getRegion(), region);
    assert.ok(changes.length >= 1);
    assert.equal(changes[0].speaker, 'Speaker 1');
    assert.equal(changes[0].text, 'one');

    block.children[1].textContent = 'one two';
    refreshText(block);
    observerInstance.fire();
    assert.equal(changes.at(-1).text, 'one two');

    const idx = region.children.indexOf(block);
    assert.ok(idx >= 0);
    region.children.splice(idx, 1);
    observerInstance.fire();
    assert.ok(removes.some((r) => r.block === block));

    watcher.stop();
  });

  it('requires injected document and MutationObserver (no DOM globals)', () => {
    assert.throws(() => createWatcher({ MutationObserver: FakeMutationObserver, onChange() {}, onRemove() {} }), /document/);
    assert.throws(() => createWatcher({ document: {}, onChange() {}, onRemove() {} }), /MutationObserver/);
  });
});
