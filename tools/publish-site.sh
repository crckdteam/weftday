#!/bin/sh
# Publishes the "site" folder (the website) to its own place: the gh-pages branch of crckdteam/weftday,
# which GitHub serves at https://weftday.crckd.live. The app is published separately by tools/publish.sh.
set -e
cd "$(dirname "$0")/.."
sh tools/secrets.sh
out=$(mktemp -d)
cp -R site/. "$out/"
printf 'weftday.crckd.live\n' > "$out/CNAME"
touch "$out/.nojekyll"
cd "$out"
git init -q -b gh-pages
git add -A
git -c user.name="Weftday" -c user.email="noreply@github.com" commit -q -m "Publish the website"
git push -q --force https://github.com/crckdteam/weftday.git gh-pages
cd - > /dev/null
rm -rf "$out"
echo "Published. It can take a minute to appear at https://weftday.crckd.live/"
