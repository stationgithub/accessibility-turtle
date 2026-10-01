# meet-caption-capture

Zero-touch capture of Google Meet live captions into a Markdown transcript. A Tampermonkey userscript: no audio, no network, no AI in the capture path.

## Why it exists

Recording a meeting and interpreting it with AI in one step is not allowed where I work. Capturing the captions Meet already draws on screen, as text, is. Anything smarter (summaries, cleanup) happens later, on the saved files, as a separate step.

## What it does (v7.1, MVP)

- Turns captions on when you join, and back on if Meet turns them off (re-checks every 15 s).
- Watches only Meet's caption region and keeps one entry per speaker turn, so Google's retroactive edits overwrite instead of duplicating.
- Autosaves every 30 s inside Tampermonkey storage. If the tab crashes, the next Meet page offers the unsaved transcript as a download.
- Writes the final file when you leave the call (leave button or the "You left the meeting" screen). Closing the tab mid-call also tries to save; if the download can't finish, the next Meet page offers it. One file per call, nothing to click.
- Names files `2026-09-30_1400.weekly-sync.47min.md` under `Meet Transcripts/2026/` in your Downloads folder, with YAML frontmatter (date, start, end, duration, title, meet code, speakers, word count, caption language, script version) so a folder or an Obsidian vault can index them.
- Replaces "You" with your name if you set one.

Not in this version: the find-and-replace dictionary for names captions get wrong (`dictionary.example.json` is a placeholder for it).

## Install (v7)

1. Install Tampermonkey.
2. Tampermonkey → Dashboard → Settings → set **Config mode** to Advanced, then **Download Mode** → **Browser API**. Without this the `Meet Transcripts/YYYY/` folder is ignored.
3. Chrome → `chrome://settings/downloads` → turn off **Ask where to save each file before downloading**.
4. Open [the built script](https://raw.githubusercontent.com/stationgithub/meet-caption-capture/main/src/meet-caption-capture.user.js) and accept the install prompt, or Tampermonkey → Utilities → Import from file → `src/meet-caption-capture.user.js`.

v6 (`legacy/v6.user.js`) can stay installed alongside it.

## Using it

An orange pill sits at the top right of Meet:

| Dot | Meaning |
| --- | --- |
| Grey | Not in a call, or still looking for the captions region |
| Orange | Capturing |
| Red | Captions not found 20 s after joining, or a download failed. The pill says which. |

The pill also shows elapsed time and the number of caption lines. **Save** downloads a `.partial.md` snapshot without stopping capture. ⚙ opens settings, where you can set the name that replaces "You". Below 900 px wide the pill shrinks to the dot; click it to expand.

## Known limits

- The leave-button, captions-button and meeting-title selectors have not been checked against a real call yet. If the dot stays grey or red with captions visible, that is the first suspect.
- If the host ends the call or you are removed, the file is written when you close the tab, or offered for recovery on the next Meet page.
- `caption_language` is always `en`.
- With two Meet tabs open, the second may offer the first tab's live autosave as a recovery download. Discard it.

## Development

`node --test` runs the tests; `node tools/build.js` rebuilds `src/meet-caption-capture.user.js` from `src/`. Design rules are in `CLAUDE.md`.
