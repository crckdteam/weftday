# How Weftday is put together

Weftday is a folder of static files. There is no server, no build step and no package to install.
The browser loads `public/index.html`, which loads plain JavaScript modules, and those modules
talk straight to Google and to any AI service the person has added.

```
  the person's browser
  +------------------------------------------------------------+
  |  public/ (HTML, CSS, JavaScript modules)                   |
  |                                                            |
  |  localStorage   tasks, settings, notes, sign-in tokens     |
  |  IndexedDB      recordings and screenshots                 |
  |  Cache          the app's own files, for offline use       |
  +------------------------------------------------------------+
        |                    |                      |
        v                    v                      v
  Google Calendar      Google Drive           AI and search services
  (events, the         (share links only,     (only with the person's
  "Weftday" calendar)  when asked)            own key, when asked)
```

## The files

Everything the app needs is in `public/`.

| File | What it does |
|---|---|
| `index.html` | The one page of the app. Holds the Content Security Policy. |
| `app.js` | The screens and everything that ties them together. |
| `google.js` | Google sign-in (PKCE) and calendar calls. |
| `store.js` | Saved state: reading and writing `localStorage`, and the `?demo` sample store. |
| `vault.js` | The same accounts and keys on every device, encrypted. Also locks setup links. |
| `notes.js` | Meeting notes, and keeping them in step with the person's Google account. |
| `editor.js` | The small block editor that notes are typed in. |
| `util.js` | Dates, time zones, text helpers (including `esc()`), and reading typed tasks. |
| `recorder.js` | The recorder: capture and storage. |
| `drive.js` | Share links: copying one recording to the person's own Google Drive. |
| `services.js` | The list of AI and web-search services, and how to call each. |
| `facts.js` | Calls to Google's AI: facts about people, writing down a recording, writing notes. |
| `ai.js` | AI that runs inside the browser (Chrome's built-in model), and the layout of tidied notes. |
| `claude.js` | "Get facts" with Claude, for people who bring their own Anthropic key. |
| `qr.js` | Draws the square (QR code) used to set up another device. |
| `sw.js` | The service worker: keeps a copy of the app's files so it opens offline. |
| `config.js` | The public address of this copy of the app, and the address it was published at before. |
| `movein.js` | Takes over what a browser saved at the app's old address, handed across by the page left there (`legacy/`). |
| `guide.html`, `guide.js`, `privacy.html`, `terms.html`, `404.html`, `site.css` | The pages around the app: the guide, the privacy policy, the terms, and the page shown for an address that is not there. They share the app's look. |
| `helpers/teams-to-google.gs` | A Google Apps Script the person can run in their own account to copy a Teams or Outlook calendar into Google. |
| `vendor/anthropic-sdk.js` | The official Anthropic SDK in one file. Loaded only when Claude is chosen. |
| `fonts/` | Figtree and Bricolage Grotesque, under the SIL Open Font License. |

Around it:

| Path | What it is |
|---|---|
| `serve.mjs` | A tiny local web server (Node.js, no dependencies) that serves `public/` on port 4321. |
| `test/` | Logic tests (`*.test.mjs`), the browser check (`smoke.py`), a check of the move from the old address (`move.py`) and a pretend Google (`mock-google.mjs`). |
| `tools/` | `check.sh` (all checks), `secrets.sh` (nothing key-shaped in the files), and the publish steps: `publish.sh` (the app), `publish-site.sh` (the website), `publish-legacy.sh` (the page at the old address). See [publishing.md](publishing.md). |
| `.github/` | The forms for issues, the pull request checklist, and the **Checks** workflow, which runs the secrets check and the quick checks on every push to `main` and every pull request. |
| `site/` | The website (https://weftday.crckd.live/), a separate static folder. It is the home page: the app itself opens straight on the day. |
| `legacy/` | The one page left at the address the app used to live at. It names the new address and moves what the browser saved at the old one. |

## Where data lives

| What | Where |
|---|---|
| Tasks, settings, notes, names of people, connected accounts and their sign-in tokens, AI keys | `localStorage` in the browser, as one saved state |
| Sample data (`?demo`) | A separate `localStorage` entry, so it never mixes with real data |
| Recordings and screenshots | IndexedDB in the browser |
| The app's own files | The browser's cache, through the service worker |
| Tasks, if the person chooses an account to save them in | Events in a calendar called "Weftday" in their own Google account |
| Meeting notes, when tasks are saved to Google | Hidden entries in that same "Weftday" calendar. Never written to the meeting itself, so other guests cannot see them. |
| The account list and keys, if "Keep my accounts the same on all my devices" is on | One hidden, encrypted entry in that same calendar |
| A shared recording | A folder called "Weftday recordings" in the person's own Google Drive |

Weftday keeps nothing anywhere else. There is no Weftday database.

Times are stored as absolute moments (milliseconds, or ISO text with an offset) and shown in the
person's own time zone.

## How sign-in works

Sign-in is Google's standard flow for web apps (the authorization code flow with PKCE), done
entirely in the browser by `google.js`.

1. The person presses **Connect Google account**. The app makes a random one-time value, keeps it
   in the browser, and sends the person to Google's own sign-in page.
2. Google sends them back to the app with a one-time code in the address. The app takes it out of
   the address bar at once.
3. The app checks that the reply belongs to the request it made, then swaps the code for tokens
   by calling Google directly.
4. The tokens are saved with the account in `localStorage`. A short-lived token is renewed from
   Google when it runs out.
5. Removing an account clears its tokens on this device. When no other device of the person's
   still uses that sign-in, Google is asked to end it too.

The app asks Google for calendar access. It asks for one more permission, to add its own files
to Drive, only the first time the person makes a share link. With that permission Weftday can see
only the files it created itself.

Today each person, or each hosted copy, uses its own Google Cloud client (a Client ID and Client
secret typed into Settings). See [self-hosting.md](self-hosting.md).

### The same accounts on every device

This is optional and off by default. When it is on, `vault.js` encrypts the account list in the
browser with AES-GCM and keeps it as a hidden entry in the person's "Weftday" calendar. Other
devices that hold the same Client secret read and decrypt it. No server is involved.

A new device is set up by scanning a square or opening a link. The link for a person's own device
carries their sign-in, so it is encrypted with a key made from a one-time code shown on the first
device, and it stops working after 15 minutes. The link for someone else's device carries only
the Google client keys.

## How the recorder works

`recorder.js` uses what the browser already has: screen capture (`getDisplayMedia`), microphone
and camera capture (`getUserMedia`) and `MediaRecorder`. Nothing is installed.

- **Four modes.** Meeting, Screen, Camera and Voice. The camera can also be drawn as a round
  picture in a corner of a screen recording, in browsers that have the newer video parts for it.
- **Written as it goes.** The recording is written to IndexedDB about once a second while it
  runs, as a row of small parts. A crash or a closed tab loses a moment at most.
- **Sound in pieces.** Next to the main recording, the sound is kept as separate pieces of about
  twenty minutes, each a complete little file at a low bit rate. These pieces are what is later
  sent to an AI, one at a time, however long the meeting was.
- **Two stores.** One holds a record per recording (when, how long, which meeting, a small
  picture, later the written text). The other holds the parts.
- **Formats.** MP4 is used where the browser can write it, because it plays everywhere. WebM is
  the fallback.
- **Rescue.** A running recording notes every few seconds that it is still alive. When the app
  next opens, a recording that was cut off is marked as finished and keeps everything written so
  far.
- **Keep awake.** While recording, the app asks the browser to keep the screen awake.
- **Joining up.** To play, download, trim or share a recording, its parts are joined into one
  file in the browser.

Recordings are not synced between devices and are never uploaded unless the person makes a share
link.

## How notes are written

Notes from a recording are written in two steps, by `app.js` with the calls in `facts.js`. They
need the person's own Google AI key.

1. **Listening.** Each sound piece is sent to Google's AI, which writes down what was said, with
   who spoke and when. If the model that marks speakers and times cannot be used, a general model
   listens instead and the times are coarser. The written text is saved with the recording.
2. **Writing.** The written text goes to an AI together with what Weftday already knows about the
   meeting: who was in it, the person's own rough notes, and what was still open from the last
   meeting with the same people. The answer comes back under plain headings: Summary, Decisions,
   Action points, Waiting on others, Open questions, Also noted.

If Google's AI is busy or has reached its free limit, the writing step (text only, never the
sound) can go to another AI service the person has saved a key for.

The notes are saved as the meeting's note, like one the person typed. Each action point can become
a task. Asking a question about one recording, or across all of them, sends the written text and
the question the same way.

Two other AI features work differently:

- **Tidy my notes** sends the note to the AI service of the person's key when they press it. Without
  a key it uses the model built into the browser, where there is one, and nothing leaves the device.
- **Get facts** about a person sends their name, company and the meeting's title to the AI service
  the person chose, only when asked.

## Offline and updates

`sw.js` keeps a copy of the app's own files. It always asks the network for the newest copy first
and falls back to the kept copy when there is no connection. Raising the version name in `sw.js`
makes every device drop the old copy. Any new file in `public/` must be added to its `FILES` list.

## The move from the old address

The app is published at https://app.weftday.crckd.live/. It used to live at another address, and
a browser keeps what a site saves under that site's address. So the one page in `legacy/` stays
at the old address. It names the new address and, with one press, opens the app there and hands
across what was saved: settings, tasks, notes, connected accounts, keys and recordings. This
happens tab to tab inside the person's own browser, through no server.

`movein.js` is the app's side. It takes things only from the very tab that opened it, and only
when the browser itself says that tab is showing the old address (`MOVED_FROM` in `config.js`).
What arrives is checked before it is saved, and anything unexpected is refused whole. A copy
hosted somewhere else is never opened by that page, so it takes nothing in.

## Safety built into the structure

- A Content Security Policy in `index.html` lets scripts load only from the app's own files and
  lets the page connect only to a fixed list of services.
- Text from outside (invites, names, AI replies, web results, the address bar) is escaped with
  `esc()` before it is put on the page.
- Links and pictures built from outside text must be `http:`, `https:` or `mailto:`.

More in [privacy-and-security.md](privacy-and-security.md).
