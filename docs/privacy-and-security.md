# Privacy and security

This page describes the model for people who want to check it against the code. The page written
for everyone who uses the app is the
[privacy policy](https://crckdteam.github.io/planner/privacy.html) (`public/privacy.html`). If the
two ever disagree, the code decides, and the mismatch is a bug worth reporting.

## The model in five lines

1. Weftday has no server. The app is static files that run in the browser.
2. Everything is kept in the person's browser (`localStorage`, IndexedDB) or in their own Google
   account.
3. AI features use a key the person gets themselves. Google's is free.
4. Nothing is sent anywhere until the person presses a button, or switches on a setting, that
   says so.
5. No analytics, no advertising, no tracking, and no accounts of Weftday's own.

## What stays on the device

- Tasks, settings, meeting notes and what is known about people.
- Sign-in tokens for each connected Google account, and the Google Client ID and Client secret.
- AI and search keys.
- Recordings and screenshots. These are never copied to other devices.

Clearing the site's data in the browser erases all of it.

## What leaves the device, and when

| What is sent | Where it goes | When |
|---|---|---|
| Requests for calendars and events; changes the person makes; replies to invitations | Google Calendar | When accounts are connected and the app is open |
| Tasks, as events in a "Weftday" calendar | The person's own Google account | If they choose an account to save tasks in |
| Meeting notes, as hidden entries in that calendar | The person's own Google account | When tasks are saved to Google |
| The account list, tokens and keys, encrypted | The person's own Google account | Only if "Keep my accounts the same on all my devices" is switched on. Off by default. |
| The sound of one recording, in pieces, with who was in the meeting, the person's own notes, and the summary and open action points from the last meeting with the same people | Google's AI, with the person's key | When they press **Make notes**, or have chosen to have notes written when that recording ends |
| The written text of a recording and a question | Google's AI, with the person's key | When they ask a question about a recording |
| The written text of a recording (never the sound) | Another AI service the person saved a key for | Only when Google's AI is busy or has reached its free limit |
| A person's name, their company and the meeting's title | The AI service the person chose, and a search service if they added one | When they press **Get facts**. Also for today's guests if they switch on the setting for that. Off by default. |
| What was typed in "Add a task", today's date and working hours | The AI service the person chose | When they press the AI button there |
| A copy of one recording | The person's own Google Drive | When they press **Share link** |
| A company's web address; a scrambled form (hash) of a person's email address | Google's site-icon service; Gravatar | When a profile or brief is opened. Can be switched off in Settings. |
| A request for the app's own files | The static host (GitHub Pages for the published app) | When the app is opened or updated |

Things that are never sent anywhere:

- **Tidy my notes** runs on the model built into the browser. Where there is none, the feature
  is not offered.
- **Follow-up email** opens a draft in the person's own Gmail. Weftday sends nothing.
- **Share my free times** writes a text to copy.

Each outside service has its own terms for what it receives. The privacy policy names them.

## Recording other people

Weftday reminds the person, every time, to tell everyone that they are recording. Following the
law on recording is the responsibility of the person who records.

A share link opens for anyone who has it. **Stop sharing** removes the copy from Drive, and the
link stops working.

## Security measures

- **Content Security Policy.** Set in `public/index.html`. Scripts load only from the app's own
  files. Connections are allowed only to a fixed list of services. Frames, plugins and a changed
  base address are refused.
- **Escaping.** Calendar invites, attendee names, AI replies, web results, synced notes and
  anything from the address bar go through `esc()` before they reach the page.
- **Scheme check.** A link or picture built from outside text must be `http:`, `https:` or
  `mailto:`.
- **Sign-in.** The authorization code flow with PKCE, with a one-time value checked on return.
  The one-time code is taken out of the address bar at once. Tokens are kept in the browser and
  cleared when an account is removed, and Google is asked to end that sign-in.
- **Least access.** Calendar access is asked for at sign-in. Drive access is asked for only when
  the first share link is made, and covers only files Weftday created.
- **Keys.** Sent only to the service they belong to, in a header where the service allows it.
  Never written to a log, a message on screen or an error.
- **Encrypted sync.** The optional account list is encrypted with AES-GCM in the browser before
  it is kept in the person's Google account. Its key is made from the Client secret, so it is as
  private as that secret.
- **Setup links.** A link that signs a person's own device in is encrypted with a key made from
  a one-time code (PBKDF2, then AES-GCM) and stops working after 15 minutes.
- **No secrets in the repository.** `tools/secrets.sh` looks for anything key-shaped and stops a
  publish that contains it.
- **Checks before publishing.** `tools/publish.sh` runs the secrets check, the logic tests and
  the browser check, and refuses to publish if any fails.

## Limits worth knowing

- Data in the browser is as safe as the device and the browser profile it is in. Anyone who can
  open the browser on an unlocked device, or a harmful browser extension, can read it.
- The Client secret, sign-in tokens and keys are stored in `localStorage` without a password.
  A browser app with no server has nowhere more private to keep them.
- The published app is served by GitHub Pages. Like any web host, it may record technical details
  such as an IP address when files are downloaded.
- With a free key, Google says it may use what is sent to improve its products.
- A published Outlook calendar link (used by the Teams helper) can be read by anyone who has it.

## Reporting a problem

Use GitHub's private vulnerability reporting, under the repository's **Security** tab. See
[../SECURITY.md](../SECURITY.md). Never post keys, tokens or private calendar details in a public
issue.
