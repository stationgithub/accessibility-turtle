import { describe, it } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  fileTitle,
  meetingName,
  MIN_WORDS,
  buildFilename,
  buildPath,
  buildFrontmatter,
  buildMarkdown,
  prepareTurns,
  countWords,
  downloadMarkdown,
  SCRIPT_VERSION,
} from '../src/writer.js';

// Local-time constructor so tests are timezone-independent.
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

const session = {
  title: 'Weekly Sync: Q3 Planning',
  meetCode: 'abc-defg-hij',
  startedAt: at(2026, 9, 30, 9, 5),
  endedAt: at(2026, 9, 30, 9, 47),
  captionLanguage: 'en',
  turns: [
    { speaker: 'You', text: 'Hello everyone.' },
    { speaker: 'Speaker 1', text: 'Hi, thanks for joining today.' },
    { speaker: 'You', text: 'Let us start.' },
  ],
};

describe('fileTitle', () => {
  it('turns spaces into underscores and drops characters that break files or links', () => {
    assert.equal(fileTitle('Weekly Sync: Q3 / Planning'), 'Weekly_Sync_Q3_Planning');
  });
  it('joins "&" without spaces', () => {
    assert.equal(fileTitle('Henley & Eric'), 'Henley&Eric');
  });
  it('returns empty for nothing usable', () => {
    assert.equal(fileTitle('  ???  '), '');
    assert.equal(fileTitle(null), '');
  });
  it('truncates without a trailing underscore', () => {
    assert.equal(fileTitle('aaaa bbbb', 5), 'aaaa');
  });
});

describe('meetingName', () => {
  const turns = [
    { speaker: 'You', text: 'hi' },
    { speaker: 'Eric Smith', text: 'hello' },
    { speaker: 'Priya Rao', text: 'hey' },
  ];
  it('uses the calendar title first', () => {
    assert.equal(meetingName({ title: 'Henley & Eric', meetCode: 'abc-defg-hij', turns }), 'Henley&Eric');
  });
  it('falls back to who spoke (first names, you left out) when there is no title', () => {
    assert.equal(meetingName({ title: '', meetCode: 'abc-defg-hij', turns }), 'Eric&Priya');
  });
  it('ignores a title that is just the room code', () => {
    assert.equal(meetingName({ title: 'abc-defg-hij', meetCode: 'abc-defg-hij', turns }), 'Eric&Priya');
  });
  it('names you when you were the only speaker', () => {
    const solo = [{ speaker: 'You', text: 'testing' }];
    assert.equal(meetingName({ title: '', meetCode: 'abc-defg-hij', turns: solo }, { myName: 'Henley' }), 'Henley');
  });
  it('caps the speaker list at three plus a count', () => {
    const many = ['A x', 'B x', 'C x', 'D x', 'E x'].map((speaker) => ({ speaker, text: 't' }));
    assert.equal(meetingName({ title: '', meetCode: '', turns: many }), 'A&B&C+2');
  });
  it('falls back to the room code, then "Meeting"', () => {
    assert.equal(meetingName({ title: '', meetCode: 'abc-defg-hij', turns: [] }), 'abc-defg-hij');
    assert.equal(meetingName({ title: '', meetCode: '', turns: [] }), 'Meeting');
  });
});

describe('buildFilename', () => {
  it('follows <Name>_YYYY-MM-DD.md', () => {
    assert.equal(buildFilename(session), 'Weekly_Sync_Q3_Planning_2026-09-30.md');
  });
  it('marks autosave copies as .partial.md', () => {
    assert.equal(buildFilename(session, { partial: true }), 'Weekly_Sync_Q3_Planning_2026-09-30.partial.md');
  });
  it('zero-pads month and day', () => {
    const s = { ...session, startedAt: at(2026, 1, 2, 0, 3), endedAt: at(2026, 1, 2, 0, 33) };
    assert.equal(buildFilename(s), 'Weekly_Sync_Q3_Planning_2026-01-02.md');
  });
});

describe('buildPath', () => {
  it('puts the file under Meet Captions/YYYY/', () => {
    assert.equal(buildPath(session), 'Meet Captions/2026/Weekly_Sync_Q3_Planning_2026-09-30.md');
  });
  it('keeps the partial suffix', () => {
    assert.match(buildPath(session, { partial: true }), /_2026-09-30\.partial\.md$/);
  });
});

describe('MIN_WORDS', () => {
  it('is 20', () => {
    assert.equal(MIN_WORDS, 20);
  });
});

describe('buildFrontmatter', () => {
  const turns = prepareTurns(session.turns, { myName: 'Henley' });
  const fm = buildFrontmatter(session, turns);

  it('contains exactly the specified keys in order', () => {
    const keys = fm
      .split('\n')
      .slice(1, -1)
      .map((l) => l.split(':')[0]);
    assert.deepEqual(keys, [
      'date',
      'start',
      'end',
      'duration_min',
      'title',
      'meet_code',
      'speakers',
      'word_count',
      'caption_language',
      'script_version',
      'tool',
      'purpose',
    ]);
  });
  it('is delimited by --- lines', () => {
    const lines = fm.split('\n');
    assert.equal(lines[0], '---');
    assert.equal(lines.at(-1), '---');
  });
  it('renders values', () => {
    assert.match(fm, /^date: 2026-09-30$/m);
    assert.match(fm, /^start: "09:05"$/m);
    assert.match(fm, /^end: "09:47"$/m);
    assert.match(fm, /^duration_min: 42$/m);
    assert.match(fm, /^title: "Weekly Sync: Q3 Planning"$/m);
    assert.match(fm, /^meet_code: "abc-defg-hij"$/m);
    assert.match(fm, /^speakers: \["Henley", "Speaker 1"\]$/m);
    assert.match(fm, /^word_count: 10$/m);
    assert.match(fm, /^caption_language: "en"$/m);
    assert.match(fm, new RegExp(`^script_version: "${SCRIPT_VERSION}"$`, 'm'));
    assert.match(fm, /^tool: "Accessibility Turtle"$/m);
    assert.match(fm, /^purpose: "accessibility caption aid/m);
  });
  it('quotes titles so YAML-special characters stay safe', () => {
    const out = buildFrontmatter({ ...session, title: 'He said "hi": #1' }, turns);
    assert.match(out, /^title: "He said \\"hi\\": #1"$/m);
  });
  it('falls back to the meet code as title', () => {
    const out = buildFrontmatter({ ...session, title: '' }, turns);
    assert.match(out, /^title: "abc-defg-hij"$/m);
  });
});

describe('prepareTurns / body', () => {
  it('replaces "You" with MY_NAME', () => {
    const turns = prepareTurns(session.turns, { myName: 'Henley' });
    assert.equal(turns[0].speaker, 'Henley');
    assert.equal(turns[1].speaker, 'Speaker 1');
  });
  it('keeps "You" when MY_NAME is empty', () => {
    assert.equal(prepareTurns(session.turns)[0].speaker, 'You');
  });
  it('drops empty turns and collapses whitespace', () => {
    const turns = prepareTurns([
      { speaker: 'A', text: '   ' },
      { speaker: 'B', text: 'one   two\n three' },
    ]);
    assert.deepEqual(turns, [{ speaker: 'B', text: 'one two three' }]);
  });
  it('applies the dictionary transform only when provided', () => {
    const transform = (t) => t.replace(/teh/g, 'the');
    assert.equal(prepareTurns([{ speaker: 'A', text: 'teh cat' }], { transform })[0].text, 'the cat');
    assert.equal(prepareTurns([{ speaker: 'A', text: 'teh cat' }])[0].text, 'teh cat');
  });
  it('counts words', () => {
    assert.equal(countWords([{ text: 'a b c' }, { text: 'd' }]), 4);
  });
});

describe('buildMarkdown', () => {
  it('emits frontmatter then one **Speaker:** paragraph per turn', () => {
    const md = buildMarkdown(session, { myName: 'Henley' });
    const [, fm, body] = md.split(/^---$/m);
    assert.ok(fm.includes('duration_min: 42'));
    assert.equal(
      body.trim(),
      [
        '**Henley:** Hello everyone.',
        '**Speaker 1:** Hi, thanks for joining today.',
        '**Henley:** Let us start.',
      ].join('\n\n'),
    );
    assert.ok(md.endsWith('\n'));
  });
});

describe('downloadMarkdown', () => {
  function fakes(behaviour) {
    const revoked = [];
    const calls = [];
    return {
      revoked,
      calls,
      deps: {
        Blob: class {
          constructor(parts, opts) {
            this.parts = parts;
            this.type = opts.type;
          }
        },
        URL: {
          createObjectURL: () => 'blob:fake',
          revokeObjectURL: (u) => revoked.push(u),
        },
        GM_download: (opts) => {
          calls.push(opts);
          behaviour(opts);
        },
      },
    };
  }

  it('passes the path as name, downloads once, and revokes the blob URL', async () => {
    const f = fakes((o) => o.onload());
    const out = await downloadMarkdown(f.deps, { path: 'Meet Captions/2026/x.md', content: 'hi' });
    assert.equal(out, 'Meet Captions/2026/x.md');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].name, 'Meet Captions/2026/x.md');
    assert.equal(f.calls[0].url, 'blob:fake');
    assert.deepEqual(f.revoked, ['blob:fake']);
  });
  it('rejects on error and still revokes', async () => {
    const f = fakes((o) => o.onerror({ error: 'not_permitted' }));
    await assert.rejects(downloadMarkdown(f.deps, { path: 'p.md', content: 'x' }), /not_permitted/);
    assert.deepEqual(f.revoked, ['blob:fake']);
  });
  it('rejects if GM_download throws', async () => {
    const f = fakes(() => {
      throw new Error('boom');
    });
    await assert.rejects(downloadMarkdown(f.deps, { path: 'p.md', content: 'x' }), /boom/);
  });
});

describe('script version', () => {
  it('matches the userscript header @version', () => {
    const header = fs.readFileSync(new URL('../src/header.js', import.meta.url), 'utf8');
    assert.equal(/@version\s+(\S+)/.exec(header)[1], SCRIPT_VERSION);
  });
});

describe('downloadMarkdown fallback', () => {
  function env(gmBehaviour) {
    const clicks = [];
    const revoked = [];
    const timers = [];
    const body = { appendChild: (a) => a };
    const deps = {
      Blob: class {},
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: (u) => revoked.push(u) },
      GM_download: gmBehaviour,
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      document: {
        body,
        createElement: () => ({ style: {}, click() { clicks.push(this.download); }, remove() {} }),
      },
    };
    return { deps, clicks, revoked, timers };
  }
  const path = 'Meet Captions/2026/2026-10-01_1316.abc-defg-hij.2min.md';

  it('falls back to a plain browser download when Tampermonkey refuses (not_whitelisted)', async () => {
    const e = env((o) => o.onerror({ error: 'not_whitelisted' }));
    const out = await downloadMarkdown(e.deps, { path, content: 'x' });
    assert.equal(out, '2026-10-01_1316.abc-defg-hij.2min.md');
    assert.deepEqual(e.clicks, ['2026-10-01_1316.abc-defg-hij.2min.md']);
    assert.deepEqual(e.revoked, [], 'blob URL is not revoked before the browser reads it');
    e.timers[0].fn();
    assert.deepEqual(e.revoked, ['blob:x']);
  });

  it('falls back when GM_download is missing', async () => {
    const e = env(undefined);
    await downloadMarkdown(e.deps, { path, content: 'x' });
    assert.equal(e.clicks.length, 1);
  });

  it('does not fall back on timeout, so a late GM download cannot make a second file', async () => {
    const e = env((o) => o.ontimeout());
    await assert.rejects(downloadMarkdown(e.deps, { path, content: 'x' }), /timeout/);
    assert.equal(e.clicks.length, 0);
  });

  it('downloads at most once if Tampermonkey reports twice', async () => {
    const e = env((o) => {
      o.onerror({ error: 'not_whitelisted' });
      o.onerror({ error: 'not_whitelisted' });
      o.onload();
    });
    await downloadMarkdown(e.deps, { path, content: 'x' });
    assert.equal(e.clicks.length, 1);
  });
});
