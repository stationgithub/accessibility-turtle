# meet-caption-capture

Tampermonkey userscript that captures Google Meet's on-screen live captions into a
Markdown transcript file, with no clicks. JavaScript, no build dependencies, no framework.

## The constraint that shapes everything
This tool exists because recording audio and interpreting it with AI at the same time
is not permitted for the owner at work. The script therefore:
- reads only the caption text Meet already renders in the DOM
- never touches audio, microphone or screen capture APIs
- never makes a network request and never calls a model
- does deterministic string replacement at most (the dictionary module, default off)
Any change that sends data off the page, adds a model call, or captures audio is out
of scope. Do not propose it.

## Do not touch
- `legacy/v6.user.js` is frozen. Never edit it. It is the working baseline the owner
  compares against.
- Never commit anything under `transcripts/`, `dictionary.json`, or `*.local.*`.
- Never commit a fixture that contains real names or `@nytimes.com` addresses. The
  fixture exporter replaces speaker names with `Speaker 1`, `Speaker 2`; check before
  committing anyway.

## Layout
```
src/
  meet-caption-capture.user.js   built output, installable, committed
  header.js      Tampermonkey metadata block (@name, @match, @grant GM_download GM_setValue GM_getValue)
  watcher.js     finds the caption region, observes ONLY that subtree, emits change/remove events
  store.js       WeakMap block -> {speaker, text, longestText, startedAt}; finalizes on remove
  lifecycle.js   in-call detection, auto-captions, autosave, save-on-leave, crash recovery
  writer.js      dictionary, frontmatter, filename, GM_download
  dictionary.js  replacement map, applied only when the setting is on
  ui.js          pill + settings panel
test/
  fixtures/      caption DOM snapshots + mutation logs from real calls (scrubbed)
  *.test.js      node:test, run with `node --test`
tools/
  build.js       concatenates header + src modules into the user.js
  index.js       builds transcripts/index.md from frontmatter
legacy/
  v6.user.js     frozen
```

## Rules for the capture core
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
- Filename: `YYYY-MM-DD_HHMM.<kebab-title>.<N>min.md`. Title from the in-call title
  element, fallback to the meet code. Autosave copies are `...partial.md`.
- Download path: `Meet Transcripts/YYYY/<filename>` via `GM_download` (needs Tampermonkey
  download mode set to Browser API).
- Frontmatter keys: date, start, end, duration_min, title, meet_code, speakers,
  word_count, caption_language, script_version.
- Body: one `**Speaker:** text` paragraph per turn. "You" is replaced by the MY_NAME
  setting.

## UI rules
- Pill at top right, orange, one Save button, a status dot (grey: no captions region,
  orange: capturing, red: warning), elapsed time, line count.
- Nothing the script renders may sit in the bottom 120 px of the viewport at any width.
- Below 900 px wide the pill collapses to the dot; click expands it.

## Workflow
- One phase per branch and pull request. Phases: capture core, lifecycle + writer, UI,
  dictionary.
- `node --test` must pass before any PR. Run `node tools/build.js` and commit the built
  user.js in the same PR.
- The owner installs the built file in Tampermonkey and runs it beside v6 for real
  meetings. Do not remove or rename v6 anywhere.
