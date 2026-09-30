import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUI, layoutFor, formatElapsed, statusView, UI } from '../src/ui.js';

// ---- minimal fake DOM ----------------------------------------------------

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.disabled = false;
    this._text = '';
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  set innerHTML(_) {
    throw new Error('TrustedHTML required (Meet enforces Trusted Types)');
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    this.children.splice(this.children.indexOf(c), 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, event = {}) {
    return Promise.all((this.listeners[type] || []).map((fn) => fn(event)));
  }
  all(role, out = []) {
    if (this.attributes['data-mcc'] === role) out.push(this);
    for (const c of this.children) c.all(role, out);
    return out;
  }
  /** Visible if it and every ancestor are not display:none. */
  get shown() {
    for (let n = this; n; n = n.parentNode) if (n.style && n.style.display === 'none') return false;
    return this.isConnected;
  }
}

function fakeEnv({ width = 1400, height = 900, stored = {} } = {}) {
  const document = {};
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = new FakeElement('html', document);
  document.body = document.documentElement.appendChild(new FakeElement('body', document));

  const winListeners = {};
  const window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener: (t, fn) => (winListeners[t] = fn),
    removeEventListener: (t) => delete winListeners[t],
    resize(w, h) {
      window.innerWidth = w;
      window.innerHeight = h;
      winListeners.resize();
    },
  };
  const values = { ...stored };
  const timers = [];
  const saves = [];
  let saveResult = 'Meet Transcripts/2026/x.partial.md';
  const env = {
    document,
    window,
    values,
    timers,
    saves,
    setSaveResult: (r) => (saveResult = r),
  };
  env.ui = createUI({
    document,
    window,
    getValue: (k, d) => (k in values ? values[k] : d),
    setValue: (k, v) => (values[k] = v),
    onSave: async () => {
      saves.push(1);
      if (saveResult instanceof Error) throw saveResult;
      return saveResult;
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  });
  env.one = (role) => {
    const found = document.documentElement.all(role);
    assert.equal(found.length, 1, `exactly one [data-mcc=${role}]`);
    return found[0];
  };
  return env;
}

// ---- layout --------------------------------------------------------------

describe('layoutFor: nothing in the bottom 120 px', () => {
  it('keeps the pill and drawer above the reserve at every size', () => {
    for (let width = 200; width <= 3000; width += 50) {
      for (let height = 100; height <= 2000; height += 25) {
        const l = layoutFor({ width, height });
        if (!l.hidden) assert.ok(UI.top + UI.pillHeight <= height - UI.bottomReserve, `${width}x${height}`);
        if (!l.drawerHidden) {
          assert.ok(l.drawerTop + l.drawerMaxHeight <= height - UI.bottomReserve, `${width}x${height}`);
        }
      }
    }
  });

  it('hides everything when the viewport is too short to respect the reserve', () => {
    assert.equal(layoutFor({ width: 1200, height: 150 }).hidden, true);
    assert.equal(layoutFor({ width: 1200, height: 164 }).hidden, false);
  });

  it('collapses to the dot below 900 px unless expanded', () => {
    assert.equal(layoutFor({ width: 899, height: 800 }).collapsed, true);
    assert.equal(layoutFor({ width: 899, height: 800, expanded: true }).collapsed, false);
    assert.equal(layoutFor({ width: 900, height: 800 }).collapsed, false);
  });
});

describe('formatElapsed / statusView', () => {
  it('formats elapsed time', () => {
    assert.equal(formatElapsed(0), '0:00');
    assert.equal(formatElapsed(65_000), '1:05');
    assert.equal(formatElapsed(3_723_000), '1:02:03');
  });
  it('maps states to grey / orange / red', () => {
    assert.equal(statusView({ state: 'idle' }).color, 'grey');
    assert.equal(statusView({ state: 'waiting' }).color, 'grey');
    assert.equal(statusView({ state: 'capturing' }).color, 'orange');
    assert.equal(statusView({ state: 'warning' }).color, 'red');
    assert.equal(statusView({ state: 'capturing' }, 'Download failed').color, 'red');
  });
});

// ---- pill ----------------------------------------------------------------

describe('pill', () => {
  it('mounts one fixed pill at the top right, orange, with one Save button', () => {
    const env = fakeEnv();
    const root = env.one('root');
    assert.equal(root.style.position, 'fixed');
    assert.equal(root.style.top, `${UI.top}px`);
    assert.equal(root.style.right, `${UI.right}px`);
    assert.equal(root.style.bottom, undefined);
    assert.equal(env.one('pill').style.background, '#f28b25');
    assert.equal(env.one('pill').style.height, `${UI.pillHeight}px`);
    assert.equal(env.one('save').textContent, 'Save');
    assert.equal(env.document.documentElement.all('save').length, 1);
  });

  it('shows status dot, elapsed time and line count', () => {
    const env = fakeEnv();
    env.ui.update({ state: 'capturing', elapsedMs: 125_000, lines: 7 });
    assert.equal(env.one('dot').getAttribute('data-color'), 'orange');
    assert.equal(env.one('elapsed').textContent, '2:05');
    assert.equal(env.one('lines').textContent, '7 lines');
    env.ui.update({ lines: 1 });
    assert.equal(env.one('lines').textContent, '1 line');
  });

  it('is grey before captions are found and red with a visible message on warning', () => {
    const env = fakeEnv();
    env.ui.update({ state: 'waiting' });
    assert.equal(env.one('dot').getAttribute('data-color'), 'grey');
    assert.equal(env.one('message').shown, false);
    env.ui.update({ state: 'warning' });
    assert.equal(env.one('dot').getAttribute('data-color'), 'red');
    assert.equal(env.one('message').shown, true);
    assert.match(env.one('message').textContent, /Captions not found/);
    assert.match(env.one('dot').getAttribute('aria-label'), /Captions not found/);
  });

  it('shows errors in red until a save succeeds', async () => {
    const env = fakeEnv();
    env.ui.update({ state: 'capturing' });
    env.ui.showError('Download failed: not_permitted');
    assert.equal(env.one('dot').getAttribute('data-color'), 'red');
    assert.match(env.one('message').textContent, /not_permitted/);
    await env.one('save').fire('click');
    assert.equal(env.one('dot').getAttribute('data-color'), 'orange');
  });

  it('clears an error from the previous call when a new call starts', () => {
    const env = fakeEnv();
    env.ui.update({ state: 'capturing' });
    env.ui.showError('Download failed');
    env.ui.update({ state: 'idle' });
    assert.equal(env.one('dot').getAttribute('data-color'), 'red');
    env.ui.update({ state: 'waiting' });
    assert.equal(env.one('dot').getAttribute('data-color'), 'grey');
  });

  it('re-mounts itself if the page drops it', () => {
    const env = fakeEnv();
    env.document.body.removeChild(env.one('root'));
    env.ui.update({ state: 'waiting' });
    assert.equal(env.one('root').isConnected, true);
  });
});

describe('Save button', () => {
  it('is disabled outside a call', () => {
    const env = fakeEnv();
    assert.equal(env.one('save').disabled, true);
    env.ui.update({ state: 'waiting' });
    assert.equal(env.one('save').disabled, false);
  });

  it('calls onSave once and reports the result', async () => {
    const env = fakeEnv();
    env.ui.update({ state: 'capturing', lines: 2 });
    await env.one('save').fire('click');
    assert.equal(env.saves.length, 1);
    assert.equal(env.one('save').textContent, 'Saved');
    env.timers.at(-1).fn();
    assert.equal(env.one('save').textContent, 'Save');
  });

  it('says so when there is nothing to save', async () => {
    const env = fakeEnv();
    env.ui.update({ state: 'waiting' });
    env.setSaveResult(null);
    await env.one('save').fire('click');
    assert.equal(env.one('save').textContent, 'Nothing yet');
  });

  it('turns red if onSave throws', async () => {
    const env = fakeEnv();
    env.ui.update({ state: 'capturing' });
    env.setSaveResult(new Error('boom'));
    await env.one('save').fire('click');
    assert.equal(env.one('dot').getAttribute('data-color'), 'red');
    assert.match(env.one('message').textContent, /boom/);
  });
});

describe('narrow viewport', () => {
  it('collapses to the dot below 900 px; clicking the dot expands and collapses it', async () => {
    const env = fakeEnv({ width: 800 });
    env.ui.update({ state: 'capturing' });
    assert.equal(env.one('details').shown, false);
    assert.equal(env.one('dot').shown, true);
    await env.one('dot').fire('click');
    assert.equal(env.one('details').shown, true);
    await env.one('dot').fire('click');
    assert.equal(env.one('details').shown, false);
  });

  it('follows window resizes', () => {
    const env = fakeEnv({ width: 1400 });
    assert.equal(env.one('details').shown, true);
    env.window.resize(700, 900);
    assert.equal(env.one('details').shown, false);
    env.window.resize(1000, 900);
    assert.equal(env.one('details').shown, true);
  });

  it('keeps the red warning visible on the collapsed dot', () => {
    const env = fakeEnv({ width: 600 });
    env.ui.update({ state: 'warning' });
    assert.equal(env.one('dot').shown, true);
    assert.equal(env.one('dot').getAttribute('data-color'), 'red');
  });
});

describe('settings panel', () => {
  it('opens from the gear, stores MY_NAME, and caps its height above the reserve', async () => {
    const env = fakeEnv({ width: 1200, height: 600, stored: { MY_NAME: 'Pat' } });
    assert.equal(env.one('panel').shown, false);
    await env.one('settings-toggle').fire('click');
    assert.equal(env.one('panel').shown, true);
    assert.equal(env.one('name-input').value, 'Pat');
    const drawer = env.one('drawer');
    assert.equal(drawer.style.maxHeight, `${600 - UI.bottomReserve - (UI.top + UI.pillHeight + UI.gap)}px`);
    assert.equal(drawer.style.overflowY, 'auto');

    env.one('name-input').value = '  Sam  ';
    await env.one('name-input').fire('change');
    assert.equal(env.values.MY_NAME, 'Sam');
  });

  it('keeps typing in the name field away from Meet shortcuts', async () => {
    const env = fakeEnv();
    let stopped = 0;
    await env.one('name-input').fire('keydown', { key: 'c', stopPropagation: () => stopped++ });
    assert.equal(stopped, 1);
  });

  it('hides the drawer when the viewport is too short for it', async () => {
    const env = fakeEnv({ width: 1200, height: 200 });
    await env.one('settings-toggle').fire('click');
    assert.equal(env.one('drawer').shown, false);
    assert.equal(env.one('pill').shown, true);
  });
});

describe('recovery offer', () => {
  function offer(env) {
    const calls = [];
    const api = {
      recover: async (k) => calls.push(['recover', k]),
      discard: (k) => calls.push(['discard', k]),
    };
    env.ui.offerRecovery(
      [
        { key: 'k1', data: { startedAt: Date.now(), title: 'Weekly Sync', turns: [{}, {}] } },
        { key: 'k2', data: { meetCode: 'abc-defg-hij', turns: [{}] } },
      ],
      api,
    );
    return calls;
  }

  it('lists unsaved sessions with Download and Discard', async () => {
    const env = fakeEnv();
    const calls = offer(env);
    assert.equal(env.one('recovery').shown, true);
    const rows = env.document.documentElement.all('recovery-row');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /Weekly Sync, 2 turns/);
    assert.match(rows[1].textContent, /abc-defg-hij, 1 turn/);

    await rows[0].all('recovery-download')[0].fire('click');
    await rows[1].all('recovery-discard')[0].fire('click');
    assert.deepEqual(calls, [['recover', 'k1'], ['discard', 'k2']]);
    assert.equal(env.document.documentElement.all('recovery-row').length, 0);
    assert.equal(env.one('recovery').shown, false);
  });

  it('stays visible when the pill is collapsed', () => {
    const env = fakeEnv({ width: 600 });
    offer(env);
    assert.equal(env.one('recovery').shown, true);
  });

  it('keeps the row and shows an error if the recovery download fails', async () => {
    const env = fakeEnv();
    env.ui.offerRecovery([{ key: 'k1', data: { turns: [{}] } }], {
      recover: async () => {
        throw new Error('not_permitted');
      },
      discard: () => {},
    });
    await env.one('recovery-download').fire('click');
    assert.equal(env.document.documentElement.all('recovery-row').length, 1);
    assert.equal(env.one('dot').getAttribute('data-color'), 'red');
  });
});
