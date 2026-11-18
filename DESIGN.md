# Design

How Weftday looks, and why. Written from what is built (app: `public/styles.css`, the block "The Weftday look"; website: `site/site.css`).

## The idea

A card file. The day is kept on index cards in a green box, and each kind of thing has a coloured tab. The app is the working drawer: quiet, everything where you expect it. The website is the same drawer seen from the front: bolder, the box itself fills the page.

## Colour

| Job | App (light) | App (dark) | Website |
|---|---|---|---|
| The box (shell, page ground) | `#edf1ea` | `#111613` | `#0f3d2e` |
| Cards (content) | `#ffffff` | `#19201c` | `#fbfcf8` |
| Ink | `#17201b` | `#e7ece7` | `#17201b` on cards, `#f1f6ee` on the box |
| Soft text | `#5a675f` | `#94a199` | `#55635a`, `#b9cdbf` |
| Action and selection | `#16775a` | `#62cfa2` | cream pill on the box |

One hue for each kind of thing, used for its icon, its tab and its markers, never as decoration:

- Calendar: blue `#3566e0`
- Notes: green `#16775a`
- Recordings and the Record button: coral `#e0503a`
- People: violet `#7a57e0`
- Tasks: amber `#c98a0c`, on a pale paper card `#fff8e4`

A meeting on the calendar takes the colour of its Google account. A task is always a paper card with a tick circle. The two share a shape and a type size so they read as one family, and differ in fill so they are never confused.

## Type

- **Figtree** for everything you operate or read: 14px in the app, 18px on the website.
- **Bricolage Grotesque** for headings only: the greeting, page and box titles, website headlines. Weight 700, tracking -0.02em to -0.03em.
- Both are self-hosted (`public/fonts`, `site/fonts`), under the SIL Open Font License.
- Monospace is for code and for the setup code only.

## Shape and depth

- Radius: 10px buttons, 13 to 14px inputs and groups, 18px boxes and the main card, 26px website cards. Buttons on the website are pills.
- Shadows are soft and offset downward. The main card sits in the box with a hairline border and a faint lift.
- No gradients on text, no glass, no coloured side stripes on cards or list rows. (Calendar blocks keep a coloured left edge: that is the calendar convention people already know.)

## Motion

- App: 140 to 250ms, only to show a change of state. Nothing plays on load.
- Website: one moment, the tabs rising behind the first card. Hover lifts on buttons. The dashed lines in the privacy picture move slowly.
- Everything stops for people who ask for reduced motion.

## Words

Plain, specific, kind. Say what happens. One small step per screen. No jargon, no hype, no em dashes. Buttons name their action ("Start recording", "Check it", "Get my free key").

## The signature

The coloured tab. In the app it is the icon chip beside each place in the sidebar. On the website it is the tab standing on the top edge of every card, and the row of tabs is the navigation.
