#!/bin/sh
# Markie RS and TipTap in one live room, on the real Markie server booted on
# localhost with a scratch database and console mail (nothing is sent).
#
#   rust/crates/markie-editor/interop/run-live.sh
#
# Needs the repo's node_modules and server/node_modules (a worktree can
# symlink the main checkout's). Evidence lands in .autoloop/runs/collab-live/.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
server="$repo/server"
port="${MARKIE_TEST_PORT:-18797}"
work=$(mktemp -d "${TMPDIR:-/tmp}/markie-live-it.XXXXXX")
log="$work/server.log"
out="$repo/.autoloop/runs/collab-live/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"

if curl -fsS "http://localhost:$port/health" >/dev/null 2>&1; then echo "Port $port is already in use." >&2; exit 1; fi
[ -d "$server/node_modules" ] || { echo "server/node_modules is missing." >&2; exit 1; }

(
  cd "$server"
  exec env -u RESEND_API_KEY -u MARKIE_MAIL_LOG -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u APPLE_CLIENT_ID \
    NODE_ENV=development PORT="$port" DB_PATH="$work/markie.db" \
    BETTER_AUTH_URL="http://localhost:$port" \
    BETTER_AUTH_SECRET="local-live-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
    MARKIE_WEB_DIST="$work/no-web-dist" ENABLE_CRONS=false \
    sh -c 'node --experimental-strip-types src/migrate.ts && exec node --experimental-strip-types src/index.ts'
) >"$log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; cp "$log" "$out/server.log" 2>/dev/null; rm -rf "$work"' EXIT INT TERM

for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$port/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://localhost:$port/health" >/dev/null || { cat "$log"; exit 1; }
echo "server up on http://localhost:$port"

cd "$repo/rust"
MARKIE_CLOUD_TEST_SERVER="http://localhost:$port" MARKIE_CLOUD_TEST_LOG="$log" MARKIE_LIVE_DIR="$out" \
  cargo test -p markie-editor --test live_interop -- --nocapture --test-threads=1
# The handoff held Bob's session token; it is not evidence.
rm -f "$out/handoff.json"
echo "evidence: $out"
