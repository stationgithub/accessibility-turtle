import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  kebab,
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

describe('kebab', () => {
  it('lowercases and hyphenates', () => {
    assert.equal(kebab('Weekly Sync: Q3 Planning'), 'weekly-sync-q3-planning');
  });
  it('strips accents and punctuation', () => {
    assert.equal(kebab('Café — Résumé!!'), 'cafe-resume');
  });
  it('returns empty for nothing usable', () => {
    assert.equal(kebab('  ***  '), '');
    assert.equal(kebab(null), '');
  });
  it('truncates without a trailing hyphen', () => {
    const out = kebab('aaaa bbbb', 5);
    assert.equal(out, 'aaaa');
  });
});

describe('buildFilename', () => {
  it('follows YYYY-MM-DD_HHMM.<kebab-title>.<N>min.md', () => {
    assert.equal(buildFilename(session), '2026-09-30_0905.weekly-sync-q3-planning.42min.md');
  });
  it('falls back to the meet code when there is no title', () => {
    assert.equal(
      buildFilename({ ...session, title: '' }),
      '2026-09-30_0905.abc-defg-hij.42min.md',
    );
  });
  it('falls back to the meet code when the title has no usable characters', () => {
    assert.equal(
      buildFilename({ ...session, title: '???' }),
      '2026-09-30_0905.abc-defg-hij.42min.md',
    );
  });
  it('marks autosave copies as .partial.md', () => {
    assert.equal(
      buildFilename({ ...session, partial: true }),
      '2026-09-30_0905.weekly-sync-q3-planning.42min.partial.md',
    );
  });
  it('zero-pads hour and minute', () => {
    const s = { ...session, startedAt: at(2026, 1, 2, 0, 3), endedAt: at(2026, 1, 2, 0, 33) };
    assert.equal(buildFilename(s), '2026-01-02_0003.weekly-sync-q3-planning.30min.md');
  });
  it('never reports less than 1 minute', () => {
    const s = { ...session, endedAt: session.startedAt + 5000 };
    assert.match(buildFilename(s), /\.1min\.md$/);
  });
});

describe('buildPath', () => {
  it('puts the file under Meet Transcripts/YYYY/', () => {
    assert.equal(
      buildPath(session),
      'Meet Transcripts/2026/2026-09-30_0905.weekly-sync-q3-planning.42min.md',
    );
  });
  it('keeps the partial suffix', () => {
    assert.match(buildPath(session, { partial: true }), /\.42min\.partial\.md$/);
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
    const out = await downloadMarkdown(f.deps, { path: 'Meet Transcripts/2026/x.md', content: 'hi' });
    assert.equal(out, 'Meet Transcripts/2026/x.md');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].name, 'Meet Transcripts/2026/x.md');
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
