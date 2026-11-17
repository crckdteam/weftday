# Weftday

All your Google calendars and your tasks in one place. Schedule tasks as time blocks next to your meetings.

**Open it:** https://crckdteam.github.io/planner/  ·  [About](https://crckdteam.github.io/planner/about.html)  ·  [Privacy](https://crckdteam.github.io/planner/privacy.html)

## How it works

- It is a plain web page with no server. Everything runs in your browser and talks to Google Calendar directly.
- Your tasks, settings and sign-in keys are stored in your own browser. Nothing is stored in this repository.
- Tasks can also be saved in a "Weftday" calendar in your own Google account, which keeps your devices in step and lets your phone remind you.
- Meeting prep: private notes on any meeting (kept as hidden entries in the "Weftday" calendar, see `public/notes.js`), your history with each guest, quick look-up links, and buttons for notes apps and attached files.
- AI without a server or a key: "Tidy my notes" uses the browser's built-in model (Chrome's Prompt API, see `public/ai.js`), so notes never leave the device. "Ask AI" about a person opens the user's own AI app with a ready-made question.
- "Get facts" about a person and their company (optional, bring your own key). With a free Google AI key, Gemini reads the company's own website; adding a free Tavily search key lets it also write from real search results about the person (`public/facts.js`); with your own Claude key it uses the official Anthropic SDK and Claude's web search (`public/claude.js`, SDK bundled in `public/vendor/`). Other AI services (OpenAI, Perplexity, Groq, OpenRouter, Mistral, DeepSeek, xAI, and Ollama on your own computer) and other search services are listed in `public/services.js`, each marked free or paid in Settings. The result is saved to that person's note and shown as a profile. It can also run by itself for the people in today's meetings (off by default), and "Brief me" gathers everything for one meeting on a single screen.
- Optionally, the list of connected accounts is kept (encrypted) in that same calendar, so all your devices show the same accounts and a new device needs no Google login. See `public/vault.js`.

## Company Teams calendar

A small helper can copy a company Teams / Outlook calendar into your Google account so Weftday can show it (view-only). Press **+ Add Teams calendar** in the app, or see [public/helpers/README.md](public/helpers/README.md).

## Setting up a device

1. On a device that is already set up, open **Settings → Set up another device** and scan the square with the new device's camera (or copy the link).
2. If "Keep my accounts the same on all my devices" is switched on, the new device opens with every account already connected. Otherwise, press **+ Connect Google account** there.

The square has two versions: "My own device" (signs the device in to your accounts; the link is locked and only opens with the code shown under the square, for 15 minutes) and "Someone else's" (only the app keys).

Setting up from scratch needs a Google Cloud "OAuth client" (Client ID and secret). The steps are inside the app under **Settings → How to get these**.

## Running it on your own computer

```bash
node serve.mjs
```

Then open http://localhost:4321. Add `?demo` to the address to try it with sample data.

## Notes

The **Notes** view lists every note: what you wrote on a meeting, notes of your own, and notes written from a recording. Notes are typed in a small block editor (`public/editor.js`: `- ` bullet, `[] ` tick-box, `# ` heading) but are kept as plain text, one line per block, so they sync through the hidden entries in your “Weftday” calendar exactly as before.

## The recorder

**Record** (in the side panel, and on every meeting) keeps a meeting's sound, your screen, or your camera, with your face in a corner of the screen if you like. It also takes single screenshots. Everything is stored in the browser (IndexedDB) and never uploaded. **Make notes** sends only the sound of one recording, in short pieces, to Google's AI with your own key and writes the summary into the meeting's notes.

It needs Chrome or Edge on a computer. A phone can record the microphone and camera only. A meeting in the browser is recorded by sharing its tab with “Share with tab audio” on; a meeting in an app such as Zoom or Teams by sharing the entire screen with “Share with system audio” on.

**Share link** uploads a copy of a recording to your own Google Drive (folder “Weftday recordings”) and gives a link anyone can open. It needs the Google Drive API switched on in the Google Cloud project your OAuth keys belong to, and asks for the `drive.file` permission the first time (only files the app creates).

Notes use Google's free AI key: one model writes down what was said with who spoke and when, another writes the notes, told who was in the meeting, your own rough notes and what was still open from last time. If Google is busy, any other AI service you have saved a key for writes the notes instead.

## Checking and publishing a change

```
sh tools/check.sh      # logic tests, then the real app in Chrome with sample data and a pretend camera, microphone and screen
sh tools/publish.sh    # refuses to publish if anything looks like a private key, or if a check fails
```

The browser check needs Python's Playwright once: `python3 -m venv .venv && .venv/bin/pip install playwright` (it uses the Chrome that is already installed). Before publishing, raise the version in `public/sw.js` (`planner-shell-vN`) so every device picks up the new files. The rules for working on this project are in `CLAUDE.md`.

## Home page and guide

`public/home.html` is a one-screen introduction (first-time visitors are sent there once), and `public/guide.html` walks through the whole app in ten short steps. Both are plain static pages that share `public/site.css`.
