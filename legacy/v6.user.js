// ==UserScript==
// @name         Google Meet Stealth Transcript (V6 Word Chunk)
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Word-chunk matching to fix retroactive punctuation stutters
// @match        *://meet.google.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    let transcriptLines = ["--- Meeting Transcript ---\n"];

    // 1. Create the floating Download button
    const btn = document.createElement("button");
    btn.innerText = "💾 Download Transcript";
    btn.style.cssText = "position:fixed; bottom:20px; left:20px; z-index:9999; padding:10px; background:#00796b; color:white; border:none; border-radius:5px; cursor:pointer; font-family:sans-serif; box-shadow: 0px 4px 6px rgba(0,0,0,0.3);";
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
        const finalOutput = transcriptLines.filter(line => line.trim().length > 0).join('\n\n');
        const blob = new Blob([finalOutput], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Meet-Transcript-${new Date().toISOString().slice(0,10)}.txt`;
        a.click();
    });

    // --- THE MASTER BLOCKLIST ---
    const uiBlocklist = [
        "Turn on", "Turn off", "More options", "Leave call", "Meeting details",
        "Chat with everyone", "Raise hand", "Press Down Arrow", "Manage your pronouns",
        "Zoom in", "Enter Full Screen", "System default", "(Built-in)", "Microphone",
        "Camera", "Speaker", "BETA", "Developing an extension", "Extensions frequently cause",
        "This is not officially supported", "You have joined the call", "is presenting",
        "Send a reaction", "More emojis", "Select your room", "Font size", "Font color",
        "Open caption settings", "Live captions", "Translated captions", "Mute this participant",
        "Camera might be blocked", "Remove from the call", "Ready to join?", "Use Gemini",
        "Share notes", "Use Companion mode", "phone_forwarded", "Join and use a phone",
        "Show fewer options", "Looking for others", "open_in_full", "Background is no",
        "Your camera is", "open to anyone", "main screen", "volume_off", "Presentation audio",
        "Companion users", "picture-in-picture", "Bring the call back", "Pinned for yourself",
        "Your Presentation", "Presentation", "Expand", "they / he", "she / her", "he / him",
        "is in this call", "Presenting, annotating", "was added to the main screen"
    ];

    // Helper: Instead of checking the start of the string, check for a shared sequence of 4 words
    function isSameEvolvingSentence(oldStr, newStr) {
        // Strip all punctuation and split into an array of pure words
        const oldWords = oldStr.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 0);
        const newWords = newStr.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 0);

        // If it's a super short phrase, fall back to basic matching
        if (oldWords.length < 4 || newWords.length < 4) {
            const cleanOld = oldWords.join('');
            const cleanNew = newWords.join('');
            return cleanNew.includes(cleanOld) || cleanOld.includes(cleanNew);
        }

        // Look for 4 identical consecutive words to prove it's the same sentence
        for (let i = 0; i <= oldWords.length - 4; i++) {
            const chunk = oldWords.slice(i, i + 4).join(' ');
            if (newWords.join(' ').includes(chunk)) {
                return true;
            }
        }
        return false;
    }

    // 2. The Smart Observer
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            let newText = "";
            let targetNode = mutation.target;

            if (mutation.type === 'characterData') {
                targetNode = mutation.target.parentNode;
                newText = mutation.target.textContent.trim();
            } else if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1 && node.innerText) {
                        targetNode = node;
                        newText = node.innerText.trim();
                    } else if (node.nodeType === 3 && node.textContent) {
                        targetNode = node.parentNode;
                        newText = node.textContent.trim();
                    }
                });
            }

            if (!targetNode || targetNode.nodeType !== 1 || newText.length < 15) return;

            // --- AGGRESSIVE UI FILTER ---
            if (targetNode.closest('button, [role="button"], [role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"], [role="option"], nav, select')) return;
            if (uiBlocklist.some(blocked => newText.includes(blocked))) return;
            if (newText.split(" ").length < 4) return;

            // --- THE DEEP WATERFALL FIX ---
            let foundMatch = false;
            const searchDepth = Math.max(1, transcriptLines.length - 15);

            for (let i = transcriptLines.length - 1; i >= searchDepth; i--) {
                if (isSameEvolvingSentence(transcriptLines[i], newText)) {
                    // Overwrite the old line with the new one, as long as Google didn't massively truncate it
                    if (newText.length >= transcriptLines[i].length * 0.6) {
                        transcriptLines[i] = newText;
                    }
                    foundMatch = true;
                    break;
                }
            }

            if (!foundMatch) {
                transcriptLines.push(newText);
            }
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });
})();
