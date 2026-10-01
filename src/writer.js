/**
 * Transcript writer: filename, frontmatter, body, GM_download.
 * Pure except downloadMarkdown, whose browser APIs are injected.
 * All dates are rendered in the local timezone.
 */

export const SCRIPT_VERSION = '7.1.4';
export const DOWNLOAD_ROOT = 'Meet Transcripts';

const pad = (n) => String(n).padStart(2, '0');

export function kebab(text, max = 60) {
  return String(text == null ? '' : text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

export function durationMinutes(startedAt, endedAt) {
  return Math.max(1, Math.round((endedAt - startedAt) / 60000));
}

export function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function displayTitle({ title, meetCode }) {
  return String(title || '').trim() || meetCode || 'meeting';
}

export function buildFilename({ title, meetCode, startedAt, endedAt, partial = false }) {
  const d = new Date(startedAt);
  const stamp = `${formatDate(startedAt)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = kebab(title) || kebab(meetCode) || 'meeting';
  const minutes = durationMinutes(startedAt, endedAt);
  return `${stamp}.${slug}.${minutes}min${partial ? '.partial' : ''}.md`;
}

export function buildPath(session, { partial = false } = {}) {
  const year = new Date(session.startedAt).getFullYear();
  return `${DOWNLOAD_ROOT}/${year}/${buildFilename({ ...session, partial })}`;
}

export function displaySpeaker(speaker, myName) {
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
export function prepareTurns(turns, { myName = '', transform = null } = {}) {
  const out = [];
  for (const turn of turns || []) {
    let text = cleanText(turn.text);
    if (transform) text = cleanText(transform(text));
    if (!text) continue;
    out.push({ speaker: displaySpeaker(turn.speaker, myName), text });
  }
  return out;
}

export function countWords(turns) {
  let n = 0;
  for (const turn of turns) {
    const words = turn.text.split(' ').filter(Boolean);
    n += words.length;
  }
  return n;
}

export function buildBody(turns) {
  return turns.map((t) => `**${t.speaker}:** ${t.text}`).join('\n\n');
}

const yaml = (value) => JSON.stringify(String(value));

export function buildFrontmatter(session, turns) {
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
export function buildMarkdown(session, options = {}) {
  const turns = prepareTurns(session.turns, options);
  return `${buildFrontmatter(session, turns)}\n\n${buildBody(turns)}\n`;
}

/**
 * Plain browser download through an <a download> click, as v6 does. Browsers
 * cannot create folders this way, so only the file name is kept.
 */
export function anchorDownload({ document }, url, path) {
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
export function downloadMarkdown(deps, { path, content }) {
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

export function writeTranscript(deps, session, { partial = false, myName = '', transform = null } = {}) {
  const content = buildMarkdown(session, { myName, transform });
  const path = buildPath(session, { partial });
  return downloadMarkdown(deps, { path, content });
}
