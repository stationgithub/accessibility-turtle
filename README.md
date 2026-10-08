# Accessibility Buddy

A closed caption helper for Google Meet. A Tampermonkey userscript that keeps Meet's live captions readable and saves them as a caption log. No audio, no generated text, no summaries, no network.

**Intended use: accessibility only.** Keeping captions for reasons other than accessibility may violate your organization's policies or local consent laws. Use this tool only as a caption aid.

## Why it exists

Live captions move at the speaker's pace. Reading happens at the reader's. Meet draws captions on screen, keeps a scrollable history for the length of the call, and discards everything when the call ends. Nothing in that history can be resized, searched, or read with a screen reader at the reader's own pace.

Accessibility Buddy closes that gap. It handles only caption text Meet has already displayed on your screen. Anything smarter (summaries, cleanup) is out of scope for this tool and, where I work, is not permitted alongside anything that touches audio.

## What it does (v7.1.9)

- Turns captions on when you join, and back on if Meet turns them off (re-checks every 15 s).
- Watches only Meet's caption region and keeps one entry per speaker turn, so Google's retroactive edits overwrite instead of duplicating.
- Autosaves every 30 s inside Tampermonkey storage. If the tab crashes, the next Meet page offers the unsaved caption log as a download.
- Writes the final file when you leave the call (leave button or the "You left the meeting" screen). Closing the tab mid-call also tries to save; if the download can't finish, the next Meet page offers it. One file per call, nothing to click.
- Names files `Henley&Eric_2026-10-01.md` (calendar title, else who spoke, else the room code, then the date) under `Meet Captions/2026/` in your Downloads folder, with YAML frontmatter (date, start, end, duration, title, meet code, speakers, word count, caption language, script version, tool, purpose) so a folder or an Obsidian vault can index them.
- Replaces "You" with your name if you set one.

Not in this version: the find-and-replace dictionary for names captions get wrong (`dictionary.example.json` is a placeholder for it).

## What it never does

- Never records audio or video.
- Never creates text of its own, summarizes, or sends data anywhere.
- Never makes a network request and never calls an AI or external service.
- Never keeps captions for anyone but you: it only sees captions Meet renders on your own screen, and only when you have captions turned on.

## Install (v7)

1. Install Tampermonkey.
2. Tampermonkey → Dashboard → Settings → set **Config mode** to Advanced, then under **Downloads**: set **Download Mode** → **Browser API**, and add `.md` to **Whitelisted File Extensions**. Without these, Tampermonkey refuses the save (`not_whitelisted`) and the script falls back to a plain browser download: the file still lands in Downloads, but not in the `Meet Captions/YYYY/` folder.
3. Chrome → `chrome://settings/downloads` → turn off **Ask where to save each file before downloading**.
4. Open [the built script](https://raw.githubusercontent.com/stationgithub/meet-caption-capture/main/src/meet-caption-capture.user.js) and accept the install prompt, or Tampermonkey → Utilities → Import from file → `src/meet-caption-capture.user.js`. Avoid pasting into "Create a new script": if the editor's template header is left above the paste, Tampermonkey reads that header (`@grant none`), and the turtle flips with "Tampermonkey grants missing".

v6 (`legacy/v6.user.js`) can stay installed alongside it.

## Using it

A small dark pill with a turtle (Accessibility Buddy) sits at the top right of Meet:

| Turtle | Meaning |
| --- | --- |
| Asleep (grey shell) | Not in a call, or still looking for the captions region |
| Pencil in mouth (teal shell) | Keeping captions |
| Flipped on its back (blue shell) | Captions not found 20 s after joining, or a download failed. The pill says which. |

The pill also shows elapsed time and the number of caption lines. Click the turtle (or ›) to fold the pill down to just the turtle; drag it anywhere above Meet's toolbar. ⚙ opens settings: the name that replaces "You", **Save a copy now** (a `.partial.md` snapshot; captions keep being kept), and **Reset position**. Calls under 20 words are not saved. Below 900 px wide the pill starts folded.

## Known limits

- The leave-button, captions-button and meeting-title selectors have not been checked against a real call yet. If the turtle stays asleep or flipped with captions visible, that is the first suspect.
- If the host ends the call or you are removed, the file is written when you close the tab, or offered for recovery on the next Meet page.
- `caption_language` is always `en`.
- With two Meet tabs open, the second may offer the first tab's live autosave as a recovery download. Discard it.

## Development

`node --test` runs the tests; `node tools/build.js` rebuilds `src/meet-caption-capture.user.js` from `src/`. Design rules are in `CLAUDE.md`.

## Who this helps

Accessibility is not a category of people. Anyone can have a day, a connection, a speaker, or a meeting where speech outruns reading. Nobody needs a diagnosis, a disclosure, or a reason to use a caption aid. That said, the pace mismatch lands hardest on:

- **Deaf and hard of hearing participants**, including hearing aid and cochlear implant users, for whom captions are the primary channel, not a supplement. A caption that scrolls off is a sentence lost.
- **Auditory processing differences**, where hearing is intact but turning speech into meaning takes longer than the speech lasts. Text that waits is the accommodation.
- **ADHD**, where attention drops out for seconds at a time and the thread is gone. Re-reading restores the thread without asking anyone to repeat themselves.
- **Autistic participants**, for whom overlapping speakers, crosstalk, and fast turn-taking are hard to parse in real time. Captions are a linear record of who said what.
- **Dyslexia and slower readers**, who need more time per line than Meet gives before replacing it.
- **Brain injury, post-concussion, long COVID, chronic illness, and migraine**, where processing speed and working memory fluctuate day to day and a bad day shouldn't mean a lost meeting.
- **Anxiety and panic**, which narrow attention and make it hard to take in what was said while it's being said.
- **Non-native speakers and anyone working across accents**, where a missed word is a missed clause.
- **Anyone on a bad connection**, where audio drops but the caption engine often keeps up.

About 1 in 6 US adults report trouble hearing ([CDC, 2014 NHIS](https://www.nidcd.nih.gov/news/2015/new-prevalence-data-shows-1-6-adults-reports-trouble-hearing)). Caption research puts a comfortable reading speed near 145 words per minute, with ratings crossing into "too fast" around 170 ([Jensema, 1998](https://dcmp.org/learn/static-assets/nadh30.pdf)); meeting speech regularly runs faster. A review of more than 100 studies found captions improve comprehension, attention, and memory for everyone, not only people with hearing loss ([Gernsbacher, 2015](https://www.adaccessibility.org/adaccessibility/2015/10/01/video-captions-benefit-everyone)). WCAG 2.1 SC 1.2.4 requires live captions so people who are deaf or hard of hearing can follow real-time presentations, and leaves captioning of two-way calls to participants and hosts rather than the platform ([W3C](https://www.w3.org/WAI/WCAG21/Understanding/captions-live.html)), which is where a user-side helper lives.

Captions are read, not heard. A caption that can't be finished is not accessible. The only thing this tool changes is how long you get to read.
