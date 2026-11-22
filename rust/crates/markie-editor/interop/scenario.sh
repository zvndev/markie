#!/bin/sh
# Boot the local server and set up a live document for looking at Markie RS on
# screen: Alice (Markie RS) owns it, Bob (a TipTap peer) edits it, Carol may
# only view it. Leaves the server running; prints the scratch folder.
#
#   rust/crates/markie-editor/interop/scenario.sh <scratch dir>
#
# Then launch Markie RS (see docs/rust-port/COLLAB.md) with
# MARKIE_RS_TEST_SESSION=<scratch>/alice-session.json, start the peer with
# MARKIE_LIVE_PEER=<scratch>/bob.json, and `touch <scratch>/stop` to end it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
dir=$(cd "$1" && pwd)
port="${MARKIE_TEST_PORT:-18799}"
log="$dir/server.log"
cat > "$dir/live.md" <<'MD'
# A shared document

Markie RS opens this shared document live. Alice edits it together.

## Notes

- Carets show who is where.
- Comments sit in the margin.
MD
(
  cd "$repo/server"
  exec env -u RESEND_API_KEY -u MARKIE_MAIL_LOG -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u APPLE_CLIENT_ID \
    NODE_ENV=development PORT="$port" DB_PATH="$dir/markie.db" BETTER_AUTH_URL="http://localhost:$port" \
    BETTER_AUTH_SECRET="local-scene-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
    MARKIE_WEB_DIST="$dir/no-web-dist" ENABLE_CRONS=false \
    sh -c 'node --experimental-strip-types src/migrate.ts && exec node --experimental-strip-types src/index.ts'
) >"$log" 2>&1 &
echo $! > "$dir/server.pid"
for _ in $(seq 1 60); do curl -fsS "http://localhost:$port/health" >/dev/null 2>&1 && break; sleep 0.5; done
cd "$repo/rust"
MARKIE_CLOUD_TEST_SERVER="http://localhost:$port" MARKIE_CLOUD_TEST_LOG="$log" MARKIE_LIVE_SCENARIO_DIR="$dir" MARKIE_LIVE_SCENARIO_FILE="$dir/live.md" \
  cargo test -q -p markie-editor --test live_scenario -- --nocapture
echo "scenario ready in $dir (server pid $(cat "$dir/server.pid"))"
