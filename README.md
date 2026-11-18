# Weftday

Your calendar, your meetings, your notes. One calm place, in your browser.

[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
![No build step](https://img.shields.io/badge/build%20step-none-2ea44f)
![Runs in your browser](https://img.shields.io/badge/runs%20in-your%20browser-7a5cff)

![Weftday](site/img/cover.png)

Weftday is a free, open-source planner, meeting recorder and AI notes app. It runs entirely in
your browser. There is no server behind it.

## Why Weftday

- **One thread for the day.** The meeting on your calendar, the recording of it, the notes from it
  and the tasks that follow sit together.
- **Yours stays yours.** Everything is kept in your browser or in your own Google account. Weftday
  has no server, no accounts of its own and no analytics.
- **Free to run.** No paid tiers. AI features use a key you get yourself, and Google's is free.
- **Open and simple.** Plain HTML, CSS and JavaScript. No build step and nothing to install. You
  can read the code and host your own copy.

## What it does

- **Calendar and tasks across Google accounts.** Connect several Google accounts and see every
  calendar in one view. Add tasks and place them as time blocks next to your meetings.
- **Teams calendar.** A small helper that runs in your own Google account copies a company Teams
  or Outlook calendar into Google, so Weftday can show it (view only). See
  [public/helpers/README.md](public/helpers/README.md).
- **Recorder with four modes.** Meeting (listens in and writes your notes, no bot joins the call),
  Screen (a video of your screen with its sound), Camera, and Voice (for people in the same room).
  It also takes single screenshots.
- **AI notes.** After a recording, Weftday writes down what was said with who spoke and when, then
  writes notes with decisions and action points. Action points can become tasks.
- **Ask your meetings.** Ask a question about one recording, or one question across all of them.
- **Share links through your own Google Drive.** A share link puts a copy of one recording in a
  folder in your Drive. You can switch the link off again.
- **People and company pages.** A page for each person you meet and their company, with your
  history together and, if you choose, facts gathered from the web.
- **Works offline once opened.** The app keeps a copy of its own files, and can be installed to a
  home screen.

## Your data stays yours

- Tasks, settings, notes and sign-in tokens are kept in your browser (`localStorage`). Recordings
  are kept in your browser too (IndexedDB).
- If you choose, tasks and notes are also kept in a calendar called "Weftday" in your own Google
  account, so your other devices can show them.
- Your browser talks straight to Google and to any AI service you add. Nothing passes through a
  server run by Weftday, because there is none.
- AI features use a key you get yourself and type in. It is kept in your browser.
- Nothing is sent anywhere until you press a button, or switch on a setting, that says so.
- No analytics, no advertising, no tracking.

The full detail is in [docs/privacy-and-security.md](docs/privacy-and-security.md) and in the
[privacy policy](https://app.weftday.crckd.live/privacy.html).

## Try it

- Open the app: https://app.weftday.crckd.live/
- Look around with sample data, no sign-in needed: https://app.weftday.crckd.live/?demo
- Read the guide: https://app.weftday.crckd.live/guide.html

## Run it yourself

You need [Node.js](https://nodejs.org) only for the small local server. The app itself needs
nothing.

```bash
git clone https://github.com/crckdteam/weftday.git
cd weftday
node serve.mjs
```

Then open http://localhost:4321. Add `?demo` to the address for sample data.

To host your own copy, put the `public/` folder on any static host. There is nothing to build.

## Set up Google sign-in

To connect a Google account today, you create your own Google Cloud client once (about ten
minutes) and paste its Client ID and Client secret into **Settings → Advanced**. The app shows the
steps there, and they are written out in [docs/self-hosting.md](docs/self-hosting.md).

## Project layout

```
public/    the app: plain HTML, CSS and JavaScript modules, served as it is
site/      the marketing website (a separate static folder)
test/      logic tests and the browser check
tools/     check, secrets check and publish scripts
docs/      how it is built, self-hosting, privacy and security
serve.mjs  a tiny local web server with no dependencies
```

## Checks

```bash
sh tools/check.sh          # logic tests (node --test), then the real app in Chrome
sh tools/check.sh quick    # the logic tests only
```

The browser check uses Python's Playwright and the Chrome already installed on your computer. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to switch it on.

## Status and known limits

Weftday is young and changes often. These limits are real today:

- **Google sign-in needs your own Google Cloud client.** One shared, Google-approved app is
  planned, so that connecting an account becomes a single press. Until then Google shows a "not
  verified" warning when you connect, which is expected for a private client.
- **Recording needs Chrome or Edge on a computer.** Recording a screen, a tab or a meeting's sound
  is not possible on a phone. A phone can record your voice or your camera, not a call.
- **A shared "Entire screen" ends if the computer's display goes to sleep.** Weftday asks the
  browser to keep the screen awake while it records, but the system can still override that.
- **Recordings live only in the browser you made them in.** They are not copied to your other
  devices. Download the ones you want to keep; clearing the browser's data removes them.
- **AI can get things wrong.** It can mishear, leave things out or state something that was never
  said. Read the notes before you rely on them.
- **Share links need the Google Drive API** switched on in your Google Cloud project.

## Contributing

Changes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it is short. Everyone taking
part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please do not report a security problem in a public issue. Use GitHub's private vulnerability
reporting: **Security → Report a vulnerability** on the repository. See [SECURITY.md](SECURITY.md).

## Licence

Copyright (C) 2026 CRCKD

Weftday is free software under the [GNU Affero General Public License, version 3](LICENSE)
(AGPL-3.0). You may use, study, change and share it under those terms. If you run a changed copy
for other people, you must offer them your source code.

- The fonts in `public/fonts` (Figtree and Bricolage Grotesque) are used under the SIL Open Font
  License 1.1. See [public/fonts/OFL.txt](public/fonts/OFL.txt).
- `public/vendor/anthropic-sdk.js` is the official Anthropic SDK for JavaScript, bundled into one
  file, under the Apache License 2.0. See [public/vendor/README.md](public/vendor/README.md).
- The recorder was written from scratch. Ideas were studied from [Cap](https://github.com/CapSoftware/Cap);
  no code was copied.

Weftday is an independent project. It is not made by, or connected with, Google.

Weftday is a [CRCKD](https://www.crckd.live) product.
