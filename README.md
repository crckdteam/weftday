# Weftday

All your Google calendars and your tasks in one place. Schedule tasks as time blocks next to your meetings.

**Open it:** https://crckdteam.github.io/planner/  ·  [About](https://crckdteam.github.io/planner/about.html)  ·  [Privacy](https://crckdteam.github.io/planner/privacy.html)

## How it works

- It is a plain web page with no server. Everything runs in your browser and talks to Google Calendar directly.
- Your tasks, settings and sign-in keys are stored in your own browser. Nothing is stored in this repository.
- Tasks can also be saved in a "Weftday" calendar in your own Google account, which keeps your devices in step and lets your phone remind you.

## Setting up a device

1. On a device that is already set up, open **Settings → Set up another device** and scan the square with the new device's camera (or copy the link).
2. On the new device, press **+ Connect Google account**.

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
