#!/bin/sh
# Stops a publish if something that looks like a private key or password is in the files.
# (The Google sign-in "client ID" in config.js is public by design and is not a secret.)
cd "$(dirname "$0")/.."
PATTERN='AIza[0-9A-Za-z_-]{35}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{32,}|tvly-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{30,}|xai-[A-Za-z0-9]{30,}|pplx-[A-Za-z0-9]{30,}|fc-[a-f0-9]{32}|ya29\.[A-Za-z0-9_-]{20,}|1//[A-Za-z0-9_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}'
found=$(git ls-files -z | xargs -0 grep -nIE "$PATTERN" 2>/dev/null | cut -d: -f1,2)
if [ -n "$found" ]; then
  echo "STOP: these lines look like private keys. Remove them before publishing:"
  echo "$found"
  exit 1
fi
echo "== no private keys in the files"
