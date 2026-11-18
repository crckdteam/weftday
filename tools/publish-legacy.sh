#!/bin/sh
# Publishes the "legacy" folder to the address Weftday used to live at, https://crckdteam.github.io/planner/ :
# the gh-pages branch of crckdteam/planner. That page tells people the new address and moves what
# their browser saved at the old one (see legacy/move.js and public/movein.js).
set -e
cd "$(dirname "$0")/.."
sh tools/secrets.sh
out=$(mktemp -d)
cp -R legacy/. "$out/"
cd "$out"
git init -q -b gh-pages
git add -A
git -c user.name="Weftday" -c user.email="noreply@github.com" commit -q -m "Publish the page at the old address"
git push -q --force https://github.com/crckdteam/planner.git gh-pages
cd - > /dev/null
rm -rf "$out"
echo "Published. It can take a minute to appear at https://crckdteam.github.io/planner/"
