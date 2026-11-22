#!/bin/sh
# Boot the Markie server from ../../../../server on localhost, on a scratch
# database, with mail printed to its log and never sent, then run the
# markie-cloud integration test against it.
#
#   scripts/local-server.sh            run the integration test
#   scripts/local-server.sh serve      just boot the server and wait
#
# MARKIE_SERVER_DIR points at another checkout's server/ folder, for example
# an extracted copy of a server change that is not on this branch yet.
#
# Never points at Markie Cloud. RESEND_API_KEY and MARKIE_MAIL_LOG are unset
# so the server's mail mode is "console" (server/src/email.ts): every code is
# written to the log file below, which the test reads.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../../.." && pwd)
server="${MARKIE_TEST_SERVER_DIR:-${MARKIE_SERVER_DIR:-$repo/server}}"
port="${MARKIE_TEST_PORT:-18787}"
work=$(mktemp -d "${TMPDIR:-/tmp}/markie-cloud-it.XXXXXX")
log="$work/server.log"

if curl -fsS "http://localhost:$port/health" >/dev/null 2>&1; then echo "Port $port is already in use." >&2; exit 1; fi
[ -d "$server/node_modules" ] || { echo "Run npm ci in $server first." >&2; exit 1; }

(
  cd "$server"
  exec env -i PATH="$PATH" TMPDIR="$work" \
    NODE_ENV=development \
    PORT="$port" \
    DB_PATH="$work/markie.db" \
    ASSETS_DIR="$work/assets" \
    BETTER_AUTH_URL="http://localhost:$port" \
    BETTER_AUTH_SECRET="local-integration-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
    MARKIE_WEB_DIST="$work/no-web-dist" \
    ENABLE_CRONS=false \
    sh -c 'node --experimental-strip-types src/migrate.ts && exec node --experimental-strip-types src/index.ts'
) >"$log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$work"' EXIT INT TERM

for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$port/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://localhost:$port/health" >/dev/null || { echo "The scratch server failed to start." >&2; exit 1; }
echo "server up on http://localhost:$port (log $log)"

if [ "${1:-}" = "serve" ]; then
  wait $pid
else
  cd "$here/../.."
  MARKIE_CLOUD_TEST_SERVER="http://localhost:$port" MARKIE_CLOUD_TEST_LOG="$log" \
    cargo test -p markie-cloud --test local_server "${1:-}" -- --nocapture --test-threads=1
fi
