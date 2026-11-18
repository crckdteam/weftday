## What this changes

<!-- One or two sentences, in plain words. Link the issue if there is one. -->

## Why

<!-- What is better for the person using Weftday? -->

## How it was checked

<!-- The commands you ran and what you looked at. Add a picture for anything on screen. -->

## Checklist

- [ ] `sh tools/check.sh` passes (or `sh tools/check.sh quick`, and I have said above that the browser check was not run)
- [ ] No new dependency, no build step, no server
- [ ] Words on screen are plain, and each screen asks for one small step
- [ ] Text from outside (invites, names, AI replies, web results, the address bar) is escaped before it reaches the page
- [ ] No secrets: no keys, tokens or private calendar details in the code, tests, pictures or this pull request (`sh tools/secrets.sh` looks for anything key-shaped)
- [ ] Nothing leaves the person's device without a button or a setting that says so
- [ ] A new file in `public/` is added to the `FILES` list in `public/sw.js`
- [ ] A test covers what is new (`test/*.test.mjs` or `test/smoke.py`)

The quick checks also run by themselves on this pull request (the **Checks** line below). A maintainer runs the browser check before anything is published.

By opening this pull request I agree that my contribution is offered under the GNU AGPL-3.0.
