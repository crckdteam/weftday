# Security

Weftday handles sign-in tokens, API keys and private recordings, all inside the person's own
browser. Reports of security problems are taken seriously and are welcome.

## Supported version

Only the latest published version is supported: the one at https://app.weftday.crckd.live/
and the tip of the `main` branch. Fixes are not made to older copies. If you host your own copy,
update it to get fixes.

## Report a problem privately

Use GitHub's private vulnerability reporting:

1. Open https://github.com/crckdteam/weftday
2. Go to the **Security** tab.
3. Press **Report a vulnerability** and fill in the form.

This link opens the same form: https://github.com/crckdteam/weftday/security/advisories/new

Only the maintainers can read what you send there.

Please do not open a public issue, pull request or discussion for a security problem. Never post
secrets in public issues: no API keys, sign-in tokens, client secrets, setup links or codes, and
no private calendar details or recordings. If you posted one by mistake, revoke it at the service
it belongs to straight away.

## What to include

- What the problem is and what someone could do with it.
- The steps to make it happen, as exactly as you can.
- The browser and device you used, and the address of the copy you tested (the published app, or
  your own).
- Whether it needs anything special, such as a crafted calendar invite or a person pressing a link.
- Sample data in place of real data. Use `?demo` where you can.

Replies come through the same private form. Weftday is run by a small team, so no fixed response
time is promised. Please allow a reasonable time for a fix before you write about the problem in
public.

## In scope

Problems in the code in this repository, such as:

- **Sign-in tokens.** Anything that lets a Google sign-in token or client secret leave the
  browser, stay in the address bar, or reach a service other than Google.
- **Keys.** An AI or search key sent to a service it does not belong to, or shown in an address,
  a log or a message on screen.
- **Text from outside running as code.** A calendar invite, attendee name, AI reply, web result,
  synced note or address-bar value that ends up as markup or script (cross-site scripting), or a
  link or picture with a scheme other than `http:`, `https:` or `mailto:`.
- **Links.** Setup links for another device, and share links for recordings: opening one without
  its code, after it has expired, or after sharing was stopped.
- **The encrypted account list** kept in the person's "Weftday" calendar (`public/vault.js`).
- **Recordings.** Anything that uploads or sends a recording, its sound or its text without the
  person pressing a button or switching on a setting that says so.
- **The service worker** (`public/sw.js`) keeping or serving something it should not.
- **The move from the old address** (`public/movein.js` and the page in `legacy/`): saved things
  handed to, or taken from, any tab other than the one they are meant for.
- **The Content Security Policy** in `public/index.html` being bypassed.

## Out of scope

- Problems in Google, in an AI or search service, in GitHub Pages or in the browser itself. Please
  report those to whoever makes them.
- Anything that needs the person's unlocked device, their browser profile, or a harmful browser
  extension. Data kept in the browser is only as safe as the device it is on.
- A share link, setup link or code that the person passed on themselves.
- A self-hosted copy that was changed or set up unsafely.
- What an AI writes: wrong or made-up notes are a quality problem, not a security one, unless the
  text can run as code or reach somewhere it should not.
- The Teams helper's published Outlook link being readable by anyone who has it. That is how
  Outlook's published calendars work, and the app says so.
- Missing security headers on the published site that a static host cannot set, with no working
  attack shown.
- Reports from automated scanners with no working example.

## How Weftday is built to be safe

- **No server.** The app is a folder of static files. There is no Weftday backend, database or
  account system to break into. The browser talks straight to Google and to the AI or search
  services the person adds.
- **A strict Content Security Policy.** Scripts load only from the app's own files, so text from
  an invite or an AI answer cannot run as code. The page may connect only to a fixed list of
  services, written in `public/index.html`.
- **Text from outside is escaped** before it is put on the page, and links and pictures are
  checked to be `http:`, `https:` or `mailto:`.
- **Sign-in uses PKCE.** Tokens are kept in the browser's `localStorage`, taken out of the address
  bar at once, and cleared on this device when an account is removed. When no other device of the
  person's still uses that sign-in, Google is asked to end it too.
- **Keys stay in the browser** and go only to the service they belong to.
- **No keys in the repository.** `tools/secrets.sh` stops a publish that contains anything
  key-shaped, and runs on every push to `main` and every pull request.
- **Optional sync is encrypted.** If the person switches it on, the list of connected accounts is
  encrypted in the browser (AES-GCM) before it is kept in their own Google account. A setup link
  for a person's own device is locked with a one-time code and stops working after 15 minutes.
- **Recordings stay in the browser** (IndexedDB) until the person asks for notes or a share link.

More detail: [docs/privacy-and-security.md](docs/privacy-and-security.md).
