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

The square has two versions: "My own device" (signs the device in to your accounts, never share it) and "Someone else's" (only the app keys).

Setting up from scratch needs a Google Cloud "OAuth client" (Client ID and secret). The steps are inside the app under **Settings → How to get these**.

## Running it on your own computer

```bash
node serve.mjs
```

Then open http://localhost:4321. Add `?demo` to the address to try it with sample data.

## Publishing a change

The website is the `public` folder, published from the `gh-pages` branch:

```bash
sh tools/publish.sh
```

## Home page and guide

`public/home.html` is a one-screen introduction (first-time visitors are sent there once), and `public/guide.html` walks through the whole app in ten short steps. Both are plain static pages that share `public/site.css`.
