# accessibility-turtle

Tampermonkey userscript, positioned as "Accessibility Turtle", a closed caption helper for
Google Meet. It keeps Meet's on-screen live captions readable and saves them as a Markdown
caption log, with no clicks. JavaScript, no build dependencies, no framework.

## Language rules (apply to docs, UI strings, comments, identifiers)
- The tool is an accessibility aid. Say "caption log", "keeps captions", "caption helper".
- Never use "transcript", "transcribe", "transcription", "record", "recording", or
  "capture" for what the tool does (the DOM event "capture phase" is the only exception).
  The repo was renamed from meet-caption-capture; GitHub redirects the old URL. Never describe it as a meeting recorder or note summarization tool.
- The turtle mascot is called Accessibility Turtle (formerly Accessibility Buddy).
- Intended use is accessibility only; the README says so at the top and explains the
  accessibility stance at the bottom. Keep that order.

## The constraint that shapes everything
This tool exists because recording audio and interpreting it with AI at the same time
is not permitted for the owner at work. The script therefore:
- reads only the caption text Meet already renders in the DOM
- never touches audio, microphone or screen capture APIs
- never makes a network request and never calls a model
- does deterministic string replacement at most (the dictionary module, default off)
Any change that sends data off the page, adds a model call, summarizes, or touches audio
is out of scope. Do not propose it.

## Do not touch
- `legacy/v6.user.js` is frozen. Never edit it. It is the working baseline the owner
  compares against.
- Never commit anything under `captions/` (formerly `transcripts/`), `dictionary.json`, or `*.local.*`.
- Never commit a fixture that contains real names or `@nytimes.com` addresses. The
  fixture exporter replaces speaker names with `Speaker 1`, `Speaker 2`; check before
  committing anyway.

## Layout
```
src/
  accessibility-turtle.user.js   built output, installable, committed
  header.js      Tampermonkey metadata block (@name, @match, @grant GM_download GM_setValue GM_getValue)
  watcher.js     finds the caption region, observes ONLY that subtree, emits change/remove events
  store.js       WeakMap block -> {speaker, text, longestText, startedAt}; finalizes on remove
  lifecycle.js   in-call detection, auto-captions, autosave, save-on-leave, crash recovery
  writer.js      dictionary, frontmatter, filename, GM_download
  dictionary.js  replacement map, applied only when the setting is on
  mascot.js      turtle status mascot (SVG, SMIL animation, no innerHTML)
  ui.js          pill + settings panel
test/
  fixtures/      caption DOM snapshots + mutation logs from real calls (scrubbed)
  *.test.js      node:test, run with `node --test`
tools/
  build.js       concatenates header + src modules into the user.js
  index.js       builds captions/index.md from frontmatter
legacy/
  v6.user.js     frozen
```

## Rules for the caption core
- Selectors: anchor on `aria-live`, roles, and structure (avatar, name element, text
  element per block). Never on Meet's generated class names. Confirm selectors against
  `test/fixtures/` and record the ones in use at the top of `watcher.js` with the date
  they were verified.
- `watcher.js` and `store.js` are pure: no DOM globals at module top level, everything
  injected, so tests can replay a fixture's mutation log.
- Newest text for a block overwrites old text. A block is finalized only when Meet
  removes it from the DOM, or on save.
- Two merge cases, both tested: Meet trims the head of a long block as it grows (keep
  `longestText`, merge by suffix overlap); Meet splits one turn into two blocks with the
  same speaker within 2 s (merge).
- If the caption region is not found within 20 s of joining, the UI shows a warning
  state. Never fail silently.

## Lifecycle rules
- In-call means the toolbar with the leave button exists.
- Turn captions on by clicking the button whose aria-label starts with "Turn on captions";
  fall back to dispatching the `c` shortcut. Re-check every 15 s.
- Autosave the store to `GM_setValue` every 30 s under a key that includes the meet code
  and start time. On load, if an unsaved session exists, offer a recovery download.
- Final save triggers on: leave button click, the "You left the meeting" screen,
  `beforeunload`. Exactly one download per call.

## File rules
- Filename: `<Name>_YYYY-MM-DD.md` (e.g. `Henley&Eric_2026-10-01.md`). Name is the
  calendar title (title element, else the tab title "Meet - <title>"), else first names
  of who spoke, else the meet code. Partial copies are `..._YYYY-MM-DD.partial.md`.
- A final caption log under MIN_WORDS (20) words is not saved.
- Download path: `Meet Captions/YYYY/<filename>` via `GM_download` (needs Tampermonkey
  download mode set to Browser API).
- Frontmatter keys: date, start, end, duration_min, title, meet_code, speakers,
  word_count, caption_language, script_version, tool, purpose (the last two name
  Accessibility Turtle and its accessibility-only use in every saved file).
- Body: one `**Speaker:** text` paragraph per turn. "You" is replaced by the MY_NAME
  setting.

## UI rules
- Dark chip at top right, drawn at 80%, with the turtle mascot (`mascot.js`) as the
  status: sleep (slate: idle or no captions region), awake with pencil (teal: keeping captions),
  flipped (blue: warning or error). Elapsed time, line count, settings, fold.
- Folds to just the turtle; draggable, position saved as PILL_POS, fold as PILL_FOLDED.
- Nothing the script renders may sit in the bottom 120 px of the viewport at any width.
- Below 900 px wide the pill starts folded; click expands it.

## Workflow
- One phase per branch and pull request. Phases: caption core, lifecycle + writer, UI,
  dictionary. The first three shipped as the v7 MVP (7.1.0); the dictionary is deferred.
  `writer.js` keeps its optional `transform` hook so it can be added later.
- `node --test` must pass before any PR. Run `node tools/build.js` and commit the built
  user.js in the same PR.
- The owner installs the built file in Tampermonkey and runs it beside v6 for real
  meetings. Do not remove or rename v6 anywhere.

## Verified Meet DOM (2026-09-30, solo call, English captions)
- Caption region: `div[role="region"][aria-label="Captions"]`. Observe this subtree only.
- One caption block per speaker turn: `div.nMcdL` (class names will churn; use structure).
  - `div.adE6rb` holds the avatar `img` and `span.NWpY1d` with the speaker name ("You" for self).
  - `div.ygicle` holds the caption text, rewritten in place (characterData mutations).
- The region also contains an empty `div` and a "Jump to bottom" button. Ignore any child
  that has no name span and no text div.
- A single speaker who keeps talking gets ONE block that keeps growing (1,363 chars after
  90 s, no removal). Blocks are removed only when the speaker changes or the region
  scrolls them out; finalize on save as well as on removal.
- In 284 mutations over 90 s: 235 characterData, 49 childList, one retroactive shrink
  of more than 20 chars. So the "newest text wins" rule needs the `longestText` guard.
- Fixture: `test/fixtures/2026-09-30-solo.local.json` (gitignored: it contains real
  meeting caption text). Fields: `events[]` with `t` ms, `type`, `block`, `text` (characterData),
  `len` (block text length), `blockText` on every 10th event, plus `blockStructure`.
  Replay it in tests; write a scrubbed public fixture before committing any.
