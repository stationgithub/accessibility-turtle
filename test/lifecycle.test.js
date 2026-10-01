import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle, meetCodeFromPath, titleFromTab, SELECTORS, KEY_INDEX, KEY_PREFIX } from '../src/lifecycle.js';

// ---- fakes ---------------------------------------------------------------

function fakeEnv({ path = '/abc-defg-hij', title = 'Weekly Sync' } = {}) {
  let t = Date.UTC(2026, 8, 30, 13, 0);
  const clock = { now: () => t, advance: (ms) => (t += ms) };

  const elements = new Map(); // selector -> element
  const listeners = { doc: {}, win: {} };
  const keydowns = [];
  const clicks = [];

  const leaveButton = { closest: (sel) => (sel === SELECTORS.leaveButton ? leaveButton : null) };
  const button = (label) => ({ label, click: () => clicks.push(label) });
  const titleEl = { getAttribute: () => title, textContent: title };

  const document = {
    body: { textContent: '' },
    activeElement: null,
    querySelector: (sel) => elements.get(sel) || null,
    addEventListener: (type, fn) => (listeners.doc[type] = fn),
    removeEventListener: (type) => delete listeners.doc[type],
    dispatchEvent: (e) => keydowns.push(e),
  };
  const window = {
    addEventListener: (type, fn) => (listeners.win[type] = fn),
    removeEventListener: (type) => delete listeners.win[type],
  };

  const gm = new Map();
  const downloads = [];
  let downloadBehaviour = (o) => o.onload();

  const watchers = [];
  const env = {
    clock,
    gm,
    downloads,
    clicks,
    keydowns,
    watchers,
    document,
    setDownload: (fn) => (downloadBehaviour = fn),
    joinCall() {
      elements.set(SELECTORS.leaveButton, leaveButton);
      elements.set(SELECTORS.title, titleEl);
    },
    leaveCall({ leftScreen = true } = {}) {
      elements.delete(SELECTORS.leaveButton);
      elements.delete(SELECTORS.title);
      document.body.textContent = leftScreen ? SELECTORS.leftText : '';
    },
    showCaptionsButton(on) {
      elements.delete(SELECTORS.captionsOnButton);
      elements.delete(SELECTORS.captionsOffButton);
      if (on === true) elements.set(SELECTORS.captionsOnButton, button('on'));
      if (on === false) elements.set(SELECTORS.captionsOffButton, button('off'));
    },
    clickLeave: () => listeners.doc.click({ target: leaveButton }),
    unload: () => listeners.win.beforeunload(),
    watcher: () => watchers[watchers.length - 1],
  };

  env.deps = {
    document,
    window,
    location: { pathname: path },
    MutationObserver: class {},
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    GM_download: (o) => {
      downloads.push(o);
      downloadBehaviour(o);
    },
    GM_setValue: (k, v) => gm.set(k, v),
    GM_getValue: (k, d) => (gm.has(k) ? gm.get(k) : d),
    Blob: class {
      constructor(parts) {
        this.text = parts.join('');
      }
    },
    URL: {
      createObjectURL: (b) => `blob:${downloads.length}:${b.text}`,
      revokeObjectURL: () => {},
    },
    now: clock.now,
    // Fixture calls are a few words long; the short-call rule has its own test.
    minWords: 0,
    // Timers are driven by hand through lifecycle.tick()/autosave()/ensureCaptions().
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    // Fake watcher: the test pushes caption events through it.
    createWatcher: ({ onChange, onRemove, onRegion }) => {
      const w = {
        started: false,
        start() {
          w.started = true;
        },
        stop() {
          w.started = false;
        },
        region: (r) => onRegion(r),
        say: (block, speaker, text) => onChange({ block, speaker, text }),
        remove: (block) => onRemove({ block }),
      };
      watchers.push(w);
      return w;
    },
  };
  return env;
}

const flush = () => new Promise((r) => setImmediate(r));
const content = (dl) => dl.url.split(':').slice(2).join(':');

// ---- tests ---------------------------------------------------------------

describe('meetCodeFromPath', () => {
  it('extracts the meet code', () => {
    assert.equal(meetCodeFromPath('/abc-defg-hij'), 'abc-defg-hij');
    assert.equal(meetCodeFromPath('/abc-defg-hij?authuser=0'), 'abc-defg-hij');
    assert.equal(meetCodeFromPath('/landing'), '');
  });
});

describe('titleFromTab', () => {
  it('reads the calendar title from the tab', () => {
    assert.equal(titleFromTab('Meet - Henley & Eric'), 'Henley & Eric');
    assert.equal(titleFromTab('Google Meet – Weekly Sync'), 'Weekly Sync');
  });
  it('ignores a bare "Meet" or a room code', () => {
    assert.equal(titleFromTab('Meet'), '');
    assert.equal(titleFromTab('Meet - abc-defg-hij'), '');
  });
});

describe('in-call detection', () => {
  it('starts a session only when the toolbar leave button exists', () => {
    const env = fakeEnv();
    const lc = createLifecycle(env.deps);
    lc.start();
    assert.equal(lc.getStatus().state, 'idle');
    assert.equal(env.watchers.length, 0);
    env.joinCall();
    lc.tick();
    assert.equal(env.watchers.length, 1);
    assert.equal(env.watcher().started, true);
    assert.equal(lc.getStatus().state, 'waiting');
    lc.stop();
  });
});

describe('auto-captions', () => {
  it('clicks the "Turn on captions" button when present', () => {
    const env = fakeEnv();
    env.showCaptionsButton(true);
    env.joinCall();
    const lc = createLifecycle(env.deps);
    lc.start();
    assert.deepEqual(env.clicks, ['on']);
    assert.equal(env.keydowns.length, 0);
  });

  it('falls back to the c shortcut when no button is found', () => {
    const env = fakeEnv();
    env.joinCall();
    const lc = createLifecycle(env.deps);
    lc.start();
    assert.equal(env.keydowns.length, 1);
    assert.equal(env.keydowns[0].key, 'c');
  });

  it('never presses c when captions are already on, or while typing', () => {
    const env = fakeEnv();
    env.joinCall();
    env.showCaptionsButton(false);
    const lc = createLifecycle(env.deps);
    lc.start();
    env.showCaptionsButton(null);
    env.document.activeElement = { tagName: 'textarea' };
    lc.ensureCaptions();
    assert.equal(env.keydowns.length, 0);
    assert.equal(env.clicks.length, 0);
  });

  it('stops trying once the caption region is capturing', () => {
    const env = fakeEnv();
    env.joinCall();
    env.showCaptionsButton(true);
    const lc = createLifecycle(env.deps);
    lc.start();
    env.watcher().region({});
    lc.ensureCaptions();
    assert.deepEqual(env.clicks, ['on']);
    assert.equal(lc.getStatus().state, 'capturing');
  });

  it('re-checks every 15 s, autosaves every 30 s', () => {
    const env = fakeEnv();
    const intervals = [];
    const lc = createLifecycle({ ...env.deps, setInterval: (fn, ms) => intervals.push(ms) });
    lc.start();
    assert.ok(intervals.includes(15000));
    assert.ok(intervals.includes(30000));
  });
});

describe('warning state', () => {
  it('reports warning when the region is still missing after 20 s', () => {
    const env = fakeEnv();
    env.joinCall();
    const lc = createLifecycle(env.deps);
    lc.start();
    env.clock.advance(20000);
    env.watcher().region(null);
    assert.equal(lc.getStatus().state, 'warning');
  });
});

describe('autosave and recovery', () => {
  it('autosaves under a key with meet code and start time', () => {
    const env = fakeEnv();
    env.joinCall();
    const lc = createLifecycle(env.deps);
    lc.start();
    const startedAt = env.clock.now();
    env.watcher().say({}, 'You', 'Hello there.');
    env.clock.advance(30000);
    lc.autosave();
    const key = `${KEY_PREFIX}abc-defg-hij:${startedAt}`;
    assert.deepEqual(JSON.parse(env.gm.get(KEY_INDEX)), [key]);
    const saved = JSON.parse(env.gm.get(key));
    assert.equal(saved.meetCode, 'abc-defg-hij');
    assert.equal(saved.startedAt, startedAt);
    assert.equal(saved.turns[0].text, 'Hello there.');
  });

  it('offers an unsaved session on load and downloads it as partial.md', async () => {
    const env = fakeEnv();
    env.joinCall();
    const crashed = createLifecycle(env.deps);
    crashed.start();
    env.watcher().say({}, 'Speaker 1', 'Unsaved words.');
    env.clock.advance(5 * 60000);
    crashed.autosave();
    // Tab dies without a final save; a fresh page load follows.
    let offered = null;
    const lc = createLifecycle({ ...env.deps, onRecoverable: (found, api) => (offered = { found, api }) });
    lc.start();
    assert.equal(offered.found.length, 1);
    const path = await offered.api.recover(offered.found[0].key);
    assert.match(path, /^Meet Transcripts\/\d{4}\/Weekly_Sync_\d{4}-\d{2}-\d{2}\.partial\.md$/);
    assert.deepEqual(JSON.parse(env.gm.get(KEY_INDEX)), []);
  });
});

describe('final save: exactly one download per call', () => {
  function inCall() {
    const env = fakeEnv();
    env.joinCall();
    const lc = createLifecycle(env.deps);
    lc.start();
    const w = env.watcher();
    w.region({});
    w.say({}, 'You', 'First thing.');
    env.clock.advance(2 * 60000);
    return { env, lc };
  }

  it('leave click, then the left screen, then beforeunload: one download', async () => {
    const { env, lc } = inCall();
    env.clickLeave();
    env.leaveCall();
    lc.tick();
    env.unload();
    await flush();
    assert.equal(env.downloads.length, 1);
    assert.match(env.downloads[0].name, /^Meet Transcripts\/\d{4}\/Weekly_Sync_\d{4}-\d{2}-\d{2}\.md$/);
    assert.deepEqual(JSON.parse(env.gm.get(KEY_INDEX)), []);
  });

  it('skips the file for a call under MIN_WORDS words (a test or a no-show)', async () => {
    const env = fakeEnv();
    env.joinCall();
    const lc = createLifecycle({ ...env.deps, minWords: undefined });
    lc.start();
    const w = env.watcher();
    w.region({});
    w.say({}, 'You', 'Testing one two.');
    env.leaveCall();
    lc.tick();
    await flush();
    assert.equal(env.downloads.length, 0);
    assert.deepEqual(JSON.parse(env.gm.get(KEY_INDEX) || '[]'), []);
  });

  it('left screen alone triggers the save', async () => {
    const { env, lc } = inCall();
    env.leaveCall();
    lc.tick();
    await flush();
    assert.equal(env.downloads.length, 1);
  });

  it('beforeunload alone triggers the save', async () => {
    const { env } = inCall();
    env.unload();
    await flush();
    assert.equal(env.downloads.length, 1);
  });

  it('writes MY_NAME for "You" and a **Speaker:** paragraph per turn', async () => {
    const env = fakeEnv();
    env.joinCall();
    const lc = createLifecycle({ ...env.deps, getSettings: () => ({ myName: 'Pat' }) });
    lc.start();
    const a = {};
    env.watcher().say(a, 'You', 'Hello.');
    env.watcher().remove(a);
    env.clock.advance(5000);
    env.watcher().say({}, 'Speaker 1', 'Hi Pat.');
    env.unload();
    await flush();
    const md = content(env.downloads[0]);
    assert.match(md, /\n\*\*Pat:\*\* Hello\.\n\n\*\*Speaker 1:\*\* Hi Pat\.\n$/);
    assert.match(md, /^speakers: \["Pat", "Speaker 1"\]$/m);
  });

  it('keeps the autosave when the download fails, so it can be recovered', async () => {
    const { env } = inCall();
    env.setDownload((o) => o.onerror({ error: 'not_permitted' }));
    env.unload();
    await flush();
    assert.equal(JSON.parse(env.gm.get(KEY_INDEX)).length, 1);
  });

  it('no captions, no download', async () => {
    const env = fakeEnv();
    env.joinCall();
    const lc = createLifecycle(env.deps);
    lc.start();
    env.unload();
    await flush();
    assert.equal(env.downloads.length, 0);
  });

  it('resumes capture if a leave click did not actually leave', async () => {
    const { env, lc } = inCall();
    env.clickLeave();
    await flush();
    assert.equal(env.downloads.length, 1);
    lc.tick();
    assert.equal(env.watchers.length, 1, 'no new session straight after the click');
    env.clock.advance(10000);
    lc.tick();
    assert.equal(env.watchers.length, 2, 'still in call after 10 s: capture resumes');
  });
});
