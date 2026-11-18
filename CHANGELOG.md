# Changelog

What changed in Weftday, newest first, in plain words.

The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The published app is
always the latest version, so changes are grouped by the day they were made. A numbered release
(the first is 0.1.0, on 19 November 2026) marks a point worth naming.

## 2026-11-19

### Added

- **The website, reworked for phones and desktop,** with a new product clip (a wide cut and a
  phone cut).
- **A Checks workflow on GitHub:** the secrets check and the quick checks run on every push to
  `main` and every pull request.
- **A page in `docs/` on publishing,** including where the README's pictures come from.

### Changed

- **The repository front.** The README covers what Weftday does, how to run it and its known
  limits, `docs/README.md` is an index, and the docs now word the privacy and security notes
  exactly as the app does.
- Action points ticked off in a note are no longer listed as still open with a person.

## 2026-11-18

### Added

- The GNU AGPL-3.0 licence text, a contributing guide, a security policy and a code of conduct.
- Forms for reporting a problem and suggesting a feature, and a pull request checklist.
- A `docs/` folder: how the app is built, how to host your own copy, and the privacy and
  security model.
- **Copy a note** with one press.
- **A new address for the app:** https://app.weftday.crckd.live/. A small page stays at the old
  address. It names the new one, and its **Move my things** button carries over what your browser
  saved there: tasks, notes, connected accounts, keys and recordings. Everything passes from one
  tab to the other inside your own browser, and nothing is deleted at the old address.
- **One clear box when a feature needs an AI key:** "Add your AI key to use this".
- **The website has its own address:** https://weftday.crckd.live/. It is the home page for
  Weftday and links to the app.
- A "That page is not here" page for an address that does not exist.
- **Home.** The app now opens on a Home screen, and the Weftday name at the top of the side panel
  leads back to it.
- **A notes editor and a Notes page.** Notes are typed in a small block editor (bullets,
  tick-boxes, headings) and every note is listed in one place.
- **Share links through your own Google Drive.** A copy of one recording goes into a folder in
  your Drive, with a link you can switch off again. Notes now say where they came from.
- **Notes that know who spoke and when.** Speakers and times in what was said, chapters, captions,
  and other AI services as a backup when Google's is busy.
- **Ask your meetings.** One question across every recording, as well as questions about a single
  one.
- **Trim a recording** into a shorter copy.
- **Meeting flow.** Record from the start of a meeting, a pad for your own notes while it runs,
  and notes that write themselves when it ends and know who was in the meeting.
- **Terms of use page.**
- **Keep-awake while recording**, so a computer left alone in a long meeting does not doze off
  and cut the recording short.

### Changed

- **The guide, the privacy policy and the terms share the app's look.** The guide is now five
  short steps.
- **A new look for the whole app:** a calmer sidebar, side panels, a Calendar and Notes switch,
  and simpler Record, Settings and Shortcuts screens.
- **A simpler meeting box:** who and when, three buttons and your notes, with the rest folded
  away.
- **The recorder leans toward meeting notes:** one press to record a meeting, a short Record box,
  and the notes shown first. Writing the notes is on by default unless you switch it off.
- The calendar grid was tidied.
- **Phone fixes:** Settings at full width, a week that is readable, and the guide, privacy policy
  and terms in the app's look.

### Removed

- The app's own home page and about page (`home.html` and `about.html`). The website is the home
  page now, and old links to those two pages lead there.

### Fixed

- The Drive box now says what to do when Google opens with the wrong account.

### Security

- The move from the old address was hardened after a security read.
- Setup links for your own device are now locked with a one-time code and stop working after 15
  minutes.
- A guard against calendars with look-alike names.

## 2026-11-17

### Added

- **The name Weftday.** The app was called Planner before.
- **Weftday's own recorder.** Record a tab, a window or the screen with its sound and your
  microphone, kept in the browser, with notes written from the recording. A second version added
  the camera in a corner, screenshots, floating controls, a library and a better player.
- **Meeting prep.** Private notes on any meeting, your history with each guest, a reminder of
  last time, look-up links, and a page for each person.
- **Get facts.** A short brief on a person and their company, with your own free Google AI key.
  Later the same day: a proper profile in place of raw text, a choice of other AI and search
  services (each marked free or paid), company logos and people's photos, "Not them?", "Brief me",
  and an option to look up today's guests by itself (off by default).
- **Private AI in the browser.** Tidy meeting notes and make tasks from them with the browser's
  built-in model, so the notes never leave the device.
- **Add tasks in your own words.** Type a sentence and AI turns it into separate tasks, shown
  before they are added. Repeats on chosen days, and times such as "730 pm", are understood.
- **Time zones.** Free times written in any zone, and a second zone on the calendar.
- **Today prep sheet, People and company pages, share my free times, follow-up email**, and a
  prompt after a meeting ends.
- **Teams calendar.** A helper that copies a company Teams or Outlook calendar into Google (view
  only), with a step-by-step "+ Add Teams calendar" guide in the app.
- **The same accounts on every device** (optional). The account list is kept encrypted in your
  own Google account. AI and search keys can travel with it.
- **A home page and a guide,** a first-time tour of the main screen, and a one-line tip the first
  time each feature opens.
- Search finds people and companies. The meeting screen shows faces and neater links for guests.
- A notice when a newer version of the app is ready.

### Changed

- Settings were rebuilt with sections, grouped rows, switches and status tags, and now explain
  what each AI helper is and how long each key takes to get.
- The task editor has a clearer title with a done circle, and When and Details sections.
- The Add a task box was redesigned.
- Adding a Teams calendar became one step per screen.
- Navigation and boxes move more smoothly.
- The app always fetches its newest files, so updates show at once.
- The side panel can be stretched.

### Fixed

- One account's calendar list could be handed to another when both were asked for at the same
  moment. Requests are no longer reused, and each list is checked against its account.
- An out-of-date calendar list now heals itself, and the right calendars load straight away.
- When calendars cannot be updated, the app says exactly why, and requests give up after 15
  seconds in place of waiting for ever.
- Many fixes from a deep review: sync timing, undo, repeating tasks, notes, setup links, reminders,
  reading typed tasks, and the Teams helper.
- Google's email boilerplate is hidden in meeting descriptions.

### Security

- A security pass over the whole app, and standing checks that run before every publish: logic
  tests, a browser check, and a check that nothing key-shaped is in the files.

## 2026-11-16

### Added

- **First version, called Planner.** Calendars from several Google accounts and your tasks in one
  place, with tasks placed as time blocks next to meetings.
- **Device setup.** Set up another device by scanning a square or copying a link, with an "Open
  on this computer" button.
