#!/bin/sh
# Publishes the "site" folder (the website) to its own place: the gh-pages branch of crckdteam/weftday.
# The app is published separately by tools/publish.sh.
#
#   sh tools/publish-site.sh            the website at https://crckdteam.github.io/weftday/
#   sh tools/publish-site.sh --domain   the website at https://weftday.crckd.live/
#
# Use --domain only once the domain has a CNAME record "weftday" pointing at crckdteam.github.io.
# The files in site/ are written for the domain; without --domain the addresses in them are changed
# on the way out, so that the page works at the GitHub address too.
set -e
cd "$(dirname "$0")/.."
sh tools/secrets.sh
out=$(mktemp -d)
cp -R site/. "$out/"
touch "$out/.nojekyll"
if [ "$1" = "--domain" ]; then
  printf 'weftday.crckd.live\n' > "$out/CNAME"
  where="https://weftday.crckd.live/"
else
  for f in "$out"/*.html "$out"/*.txt "$out"/*.xml; do
    sed -i.bak 's#https://weftday\.crckd\.live#https://crckdteam.github.io/weftday#g' "$f" && rm -f "$f.bak"
  done
  sed -i.bak 's#="/#="/weftday/#g' "$out/404.html" && rm -f "$out/404.html.bak"
  where="https://crckdteam.github.io/weftday/"
fi
cd "$out"
git init -q -b gh-pages
git add -A
git -c user.name="Weftday" -c user.email="noreply@github.com" commit -q -m "Publish the website"
git push -q --force https://github.com/crckdteam/weftday.git gh-pages
cd - > /dev/null
rm -rf "$out"
echo "Published. It can take a minute to appear at $where"
