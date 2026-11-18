# Publishing

This page is for maintainers: the people who can push to the repository. If you host your own
copy, you do not need any of it. Copy the `public/` folder to your host, as described in
[self-hosting.md](self-hosting.md).

Weftday is published as three separate static folders. Each has its own script in `tools/`.

| Folder | What it is | Where it goes | Script |
|---|---|---|---|
| `public/` | The app, with its guide, privacy policy and terms | https://app.weftday.crckd.live/ | `sh tools/publish.sh` |
| `site/` | The website | https://weftday.crckd.live/ | `sh tools/publish-site.sh` |
| `legacy/` | The one page left at the address the app used to live at | The old address | `sh tools/publish-legacy.sh` |

All three are served by GitHub Pages. Nothing is built on the way: each script copies its folder
as it is and pushes the copy to a `gh-pages` branch.

## Where the README's pictures come from

The pictures in `docs/img/` (used by the README) are copies of the website's pictures in
`site/img/`. They are copied by hand, and no script makes them, so copy them again when the
website's pictures change.

## Before you publish the app

1. Run the checks, and make sure they pass:

   ```bash
   sh tools/check.sh
   ```

2. If a file was added to `public/`, add it to the `FILES` list in `public/sw.js`.
3. Raise the version name in `public/sw.js` (`planner-shell-vN`), so every device drops its old
   kept copy and picks up the new files.
4. Commit. The publish script refuses to run while `public/` has changes that are not committed,
   so that what is published is what is saved.
5. A change to sign-in, keys, the encrypted account list, links built from outside text, or the
   service worker gets a careful security read first.

## The app

```bash
sh tools/publish.sh
```

In order, the script:

1. Runs `tools/secrets.sh` and stops if anything key-shaped is in the files.
2. Runs `tools/check.sh` in full (the logic tests, then the browser check) and stops if anything
   fails.
3. Stops if `public/` has changes that are not committed.
4. Copies `public/` to a temporary folder and adds a `CNAME` file there. That file tells GitHub
   the address is ours. It is added on the way out and is not kept in `public/`, so someone
   publishing their own copy of `public/` does not carry our address along.
5. Pushes that folder to the `gh-pages` branch of this repository.

It can take a minute for the new version to appear.

## The website

```bash
sh tools/publish-site.sh
```

The script runs the secrets check, copies `site/`, adds the `CNAME` file for
`weftday.crckd.live`, and pushes the copy to the `gh-pages` branch of a second repository,
`crckdteam/weftday-site`.

`sh tools/publish-site.sh --github` publishes a copy that has no domain of its own. It changes
the addresses in the files on the way out so that the page works at its GitHub address. Leaving
the `CNAME` file out takes the website off `weftday.crckd.live`, so use this only for such a copy.

The website has a strict Content Security Policy, written at the top of `site/index.html`:
scripts, styles, fonts and pictures load only from the website's own folder. A change that needs
anything from outside will not work, on purpose.

To look at the website on your own computer before publishing:

```bash
python3 -m http.server 4380 --directory site
```

Then open http://localhost:4380.

## The page at the old address

```bash
sh tools/publish-legacy.sh
```

The app used to live at another address. A browser keeps what a site saves under that site's
address, so tasks, notes, connected accounts, keys and recordings saved at the old address do not
show up at the new one by themselves. The page in `legacy/` stays at the old address, names the
new one, and hands those things across with one press: tab to tab, inside the person's own
browser, through no server. The app's side of this is `public/movein.js`.

The script runs the secrets check, copies `legacy/`, and pushes the copy to the `gh-pages` branch
of the repository the old address is served from (it is named in the script).

The full check (`sh tools/check.sh`) tries this move from end to end on your own computer, with
two local addresses standing in for the old one and the new one (`test/move.py`).

## What runs by itself

Every push to `main` and every pull request runs the **Checks** workflow
(`.github/workflows/checks.yml`): the secrets check and `sh tools/check.sh quick`. It does not
publish anything. Publishing is always done by a person, with the scripts above.
