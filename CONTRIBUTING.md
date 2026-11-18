# Contributing to Weftday

Thank you for wanting to help. Weftday is small on purpose, and these notes are short on purpose.
Please read them before you open a pull request.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Run it locally

You need [Node.js](https://nodejs.org) (a current version) and nothing else.

```bash
git clone https://github.com/crckdteam/weftday.git
cd weftday
node serve.mjs
```

Open http://localhost:4321. Add `?demo` to the address to work with sample data, which needs no
Google account and no keys. Most changes can be built and checked this way.

To work with a real Google account, create your own Google Cloud client as described in
[docs/self-hosting.md](docs/self-hosting.md).

There is no build step. Edit a file in `public/`, reload the page, and you see the change.

## The rules

These hold for every change. A pull request that breaks one will be asked to change.

### Shape of the app

- **No server.** The app is the static folder `public/`. Nothing may need a backend, and nothing
  may depend on a service that only the maintainers can provide.
- **No dependencies and no build step.** Plain HTML, CSS and JavaScript modules. No package
  manager, no bundler, no framework. If a library is truly needed, talk about it in an issue first.
- **Free to run.** No feature may need a paid service. Paid AI services are optional extras that
  the person chooses and pays for themselves.
- **Everything stays with the person.** Data is kept in the browser (`localStorage`, IndexedDB) or
  in the person's own Google account. It leaves the device only when they press a button that says
  so, or switch on a setting that says so. No analytics of any kind.

### Safety

- **Text from outside is always escaped.** Calendar invites, attendee names, AI replies, web
  results, synced notes and anything from the address bar go through `esc()` before they reach
  `innerHTML`, and through a scheme check (`http:`, `https:` or `mailto:` only) before they become
  a link or a picture.
- **No keys in the files.** API keys are typed in by the person and kept on their device. Never
  commit a key, a token or a password, not even a test one. `sh tools/secrets.sh` looks for
  anything key-shaped.
- **Keys go only to the service they belong to.** Never put a key in an address (URL) when a
  header will do, and never in a log, a message on screen or an error.
- **Sign-in tokens stay in the browser.** They are removed from the address bar at once and
  cleared on sign-out.
- **Times are absolute.** Store a moment as milliseconds or as ISO text with an offset, and show
  it through the time zone helpers. Never store a bare local time for an event.
- **Recordings are private.** Nothing is uploaded or sent to an AI without a press. The app always
  reminds the person to tell others they are being recorded.
- **Recorder code is written from scratch.** Ideas may come from other projects such as Cap. Code
  may not be copied from them.
- **A new outside service** must be added to the `connect-src` list in the Content Security
  Policy at the top of `public/index.html`, and must be described in `public/privacy.html`.

### How it should feel

- **Plain words on screen.** Name things the way a non-technical person would. No jargon.
- **One small step per screen.** Never a wall of options.
- **Calm and precise.** An error says what happened and what to do next.
- It must work on a phone, with the keyboard alone, in light and dark, and with reduced motion.

## Run the checks

```bash
sh tools/check.sh quick    # every script file reads as valid code, then the logic tests (node --test)
sh tools/check.sh          # the same, then the real app in Chrome with sample data
sh tools/secrets.sh        # nothing key-shaped in the tracked files
```

The browser check drives the Chrome already installed on your computer, with a pretend Google and
a pretend microphone, camera and screen. Switch it on once:

```bash
python3 -m venv .venv && .venv/bin/pip install playwright
```

Note: the browser check is started through a small helper script (`with_server.py`) that is not
in the repository yet. On a fresh clone, run `sh tools/check.sh quick` and say in your pull request
that the browser check was not run. A maintainer will run it.

When you add something new, add a test for it: logic in `test/*.test.mjs`, screens in
`test/smoke.py`.

If your change adds a file to `public/`, add it to the `FILES` list in `public/sw.js` so it is
kept for offline use. Maintainers raise the version in that file when they publish.

## Propose a change

1. For anything larger than a small fix, open an issue first and describe what you want to change
   and why. It saves you from building something that does not fit.
2. Fork the repository and make a branch.
3. Keep the change small and about one thing.
4. Run the checks.
5. Open a pull request and fill in the template. Say what changed, why, and how you checked it. A
   picture helps for anything on screen.

Changes to sign-in, keys, the encrypted account list (`vault.js`), links built from outside text,
or the service worker get a careful security read before they are merged. Expect questions.

Found a security problem? Do not open an issue or a pull request. See [SECURITY.md](SECURITY.md).

## Commit messages

- A short subject in the imperative: "Add a second time zone to the calendar", "Fix repeats on
  the last day of a month".
- Say what the change does for the person using the app, in plain words.
- If more needs saying, leave a blank line and write a few sentences below.

## Licence of contributions

Weftday is under the [GNU AGPL-3.0](LICENSE). By sending a contribution you agree that it is
yours to give and that it is offered under the same licence.
