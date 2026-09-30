# meet-caption-capture

Zero-touch capture of Google Meet live captions into a Markdown transcript. A Tampermonkey userscript: no audio, no network, no AI in the capture path.

## Why it exists

Recording a meeting and interpreting it with AI in one step is not allowed where I work. Capturing the captions Meet already draws on screen, as text, is. Anything smarter (summaries, cleanup) happens later, on the saved files, as a separate step.

## What it does (v7, in progress)

- Turns captions on when you join, and back on if Meet turns them off.
- Watches only Meet's caption region and keeps one entry per speaker turn, so Google's retroactive edits overwrite instead of duplicating.
- Autosaves every 30 s; writes the final file when you leave. Nothing to click.
- Names files `2026-09-30_1400.weekly-sync.47min.md` with YAML frontmatter, so a folder or an Obsidian vault can index them.
- Optional find-and-replace dictionary for names and jargon captions get wrong. Off by default.

## Status

`legacy/v6.user.js` is the working v6 script (frozen). v7 is being built module by module under `src/` with replayable DOM fixtures in `test/`. See `CLAUDE.md` for the design constraints and build order.

## Install (v6, today)

1. Install Tampermonkey.
2. Open `legacy/v6.user.js` raw and accept the install prompt.
3. Join a Meet, turn on captions, click the download button when you leave.
