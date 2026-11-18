#!/bin/sh
# Publishes the "public" folder (the app) to https://app.weftday.crckd.live/ : the gh-pages branch of
# this repository. Run from anywhere. Before anything goes out: no private keys in the files, and
# every check passes.
#
# The published folder also carries a file called CNAME, which tells GitHub that the address is ours.
# It is added here, on the way out, and is not kept in public/, so that someone publishing their own
# copy of public/ somewhere else does not carry our address along.
set -e
cd "$(dirname "$0")/.."
sh tools/secrets.sh
sh tools/check.sh
# What is published should be what is saved, so unsaved changes to the app stop the publish.
if [ -n "$(git status --porcelain -- public)" ]; then
  echo "STOP: public/ has changes that are not committed yet. Commit them, then publish again."
  exit 1
fi
out=$(mktemp -d)
cp -R public/. "$out/"
touch "$out/.nojekyll"
printf 'app.weftday.crckd.live\n' > "$out/CNAME"
version=$(grep -o 'planner-shell-v[0-9]*' public/sw.js | head -1 | sed 's/planner-shell-//')
remote=$(git remote get-url origin)
cd "$out"
git init -q -b gh-pages
git add -A
git -c user.name="Weftday" -c user.email="noreply@github.com" commit -q -m "Publish the app ($version)"
git push -q --force "$remote" gh-pages
cd - > /dev/null
rm -rf "$out"
echo "Published $version. It can take a minute to appear at https://app.weftday.crckd.live/"
