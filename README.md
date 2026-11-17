# Weftday

All your Google calendars and your tasks in one place. Schedule tasks as time blocks next to your meetings.

**Open it:** https://crckdteam.github.io/planner/  ·  [About](https://crckdteam.github.io/planner/about.html)  ·  [Privacy](https://crckdteam.github.io/planner/privacy.html)

## How it works

- It is a plain web page with no server. Everything runs in your browser and talks to Google Calendar directly.
- Your tasks, settings and sign-in keys are stored in your own browser. Nothing is stored in this repository.
- Tasks can also be saved in a "Weftday" calendar in your own Google account, which keeps your devices in step and lets your phone remind you.
- Meeting prep: private notes on any meeting (kept as hidden entries in the "Weftday" calendar, see `public/notes.js`), your history with each guest, quick look-up links, and buttons for notes apps and attached files.
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
