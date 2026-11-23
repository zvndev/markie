#!/bin/sh
# Two scratch Markie servers on localhost for background scenes: this repo's
# server/, scratch databases, console mail (no mail leaves the Mac).
#
#   servers.sh start <scratch>   primary :18991, second :18995 ("Dana's server")
#   servers.sh stop <scratch>    kill both by their pid files
#
# The headless Electron harness serves on :18990, so that origin is trusted.
set -eu
cmd=$1; dir=$(mkdir -p "$2" && cd "$2" && pwd)
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
if [ "$cmd" = stop ]; then
  for f in "$dir"/srv-*.pid; do [ -f "$f" ] && { kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }; done
  exit 0
fi
start() { port=$1; name=$2; work="$dir/srv-$port"; mkdir -p "$work"
  ( cd "$repo/server" && exec env -i PATH="$PATH" HOME="$work" TMPDIR="$work" NODE_ENV=development PORT="$port" \
      DB_PATH="$work/markie.db" ASSETS_DIR="$work/assets" BETTER_AUTH_URL="http://localhost:$port" \
      BETTER_AUTH_SECRET="local-scene-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
      MARKIE_WEB_DIST="$work/no-web-dist" ENABLE_CRONS=false MARKIE_WEB_ORIGINS="http://localhost:18990" \
      ${name:+MARKIE_SERVER_NAME="$name"} \
      sh -c 'node --experimental-strip-types src/migrate.ts && exec node --experimental-strip-types src/index.ts' ) \
    >"$work/server.log" 2>&1 &
  echo $! > "$dir/srv-$port.pid"
}
start 18991 ""
start 18995 "Dana's server"
for p in 18991 18995; do
  for _ in $(seq 1 80); do curl -fsS "http://localhost:$p/health" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fsS "http://localhost:$p/health" >/dev/null || { echo "server :$p did not start; see $dir/srv-$p/server.log" >&2; exit 1; }
done
echo "servers up: http://localhost:18991 and http://localhost:18995 (logs in $dir)"
