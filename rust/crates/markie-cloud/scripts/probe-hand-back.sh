#!/bin/sh
# Is the markie-rs:// sign-in hand-back live on Markie Cloud yet?
#
# The server change (zvndev/markie#136) adds `app=markie-rs` to the Google and
# Apple start routes. Nothing about it shows on a public route without signing
# in, so this asks the one public thing that names the build, /health, and
# looks the commit up in this git checkout. It sends no sign-in, no mail and no
# cookie. Run `git fetch origin` first so the deployed commit is known.
#
#   crates/markie-cloud/scripts/probe-hand-back.sh            Markie Cloud
#   crates/markie-cloud/scripts/probe-hand-back.sh <origin>   another server
set -eu
origin="${1:-https://api.markiedocs.com}"
commit=$(curl -fsS --max-time 10 "$origin/health" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
if [ -z "$commit" ]; then
  echo "unknown: $origin/health names no commit" >&2
  exit 2
fi
if ! git cat-file -e "$commit^{commit}" 2>/dev/null; then
  echo "unknown: commit $commit is not in this checkout; run git fetch origin" >&2
  exit 2
fi
if git show "$commit:server/src/desktop-auth.ts" 2>/dev/null | grep -q "desktopAuthApp"; then
  echo "live: $origin runs $commit, which answers app=markie-rs with markie-rs://"
  echo "Turn on Google and Apple in Markie RS: Sign In…, then \"Server updated? Turn them on\"."
else
  echo "not yet: $origin runs $commit, which still answers markie://"
  exit 1
fi
