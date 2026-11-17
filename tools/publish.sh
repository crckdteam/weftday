#!/bin/sh
# Publishes the "public" folder to the website (the gh-pages branch). Run from the repository folder.
# Before anything goes out: no private keys in the files, and every check passes.
set -e
cd "$(dirname "$0")/.."
sh tools/secrets.sh
sh tools/check.sh
git push origin "$(git subtree split --prefix public HEAD):refs/heads/gh-pages" --force
echo "Published. It can take a minute to appear at https://crckdteam.github.io/planner/"
