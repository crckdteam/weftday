#!/bin/sh
# Checks Weftday before it is published: the logic tests, then the real app in a browser.
# Run from anywhere:  sh tools/check.sh        (add "quick" to skip the browser part)
set -e
cd "$(dirname "$0")/.."
echo "== every script file reads as valid code"
tmp=$(mktemp -d)
for f in public/*.js; do cp "$f" "$tmp/$(basename "$f" .js).mjs"; node --check "$tmp/$(basename "$f" .js).mjs" || { rm -rf "$tmp"; echo "STOP: $f has a mistake in it"; exit 1; }; done
rm -rf "$tmp"
echo "== logic tests"
node --test test/*.test.mjs
[ "$1" = "quick" ] && exit 0
if [ ! -x .venv/bin/python ]; then
  echo "== browser check skipped: run  python3 -m venv .venv && .venv/bin/pip install playwright  once to switch it on"
  exit 0
fi
echo "== browser check"
PORT=4399 WEFTDAY_URL=http://localhost:4399 .venv/bin/python .claude/skills/webapp-testing/scripts/with_server.py \
  --server "PORT=4399 node test/mock-google.mjs" --port 4399 -- .venv/bin/python test/smoke.py
