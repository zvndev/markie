#!/bin/sh
# Prove the Cloud integration end to end against a server on this computer:
# sign in through the sign-in sheet's own code (scripted), turn sync on, see
# the live room start, let a TipTap peer join and type, and have an agent
# read the sync record, comment and sync a new file through the bridge.
#
#   rust/scripts/cloud-integration/run.sh <scratch dir>
#
# Needs a debug build (cargo build -p markie-app), the repo's node_modules and
# server/node_modules (a worktree can symlink the main checkout's). Mail is
# console only; the addresses are on the SES mailbox simulator. Evidence goes
# to <repo>/.autoloop/runs/cloud-integration/<stamp>/. No token is printed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
scratch=$(mkdir -p "$1" && cd "$1" && pwd)
port="${MARKIE_TEST_PORT:-18931}"
base="http://localhost:$port"
alice="success@simulator.amazonses.com"
bob="success+markie-rs-integration-bob@simulator.amazonses.com"
out="$repo/.autoloop/runs/cloud-integration/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out" "$scratch/home/Docs"
# The bridge socket path must stay under the macOS limit: a short data folder.
data=$(mktemp -d /tmp/mrsci.XXXX)

TMPDIR="$scratch" MARKIE_TEST_PORT="$port" "$repo/rust/crates/markie-cloud/scripts/local-server.sh" serve >"$scratch/serve.out" 2>&1 &
server=$!
cleanup() { touch "$scratch/stop"; [ -n "${app:-}" ] && kill "$app" 2>/dev/null; [ -n "${peer:-}" ] && kill "$peer" 2>/dev/null; kill "$server" 2>/dev/null; rm -rf "$data"; rm -f "$scratch"/*.token "$scratch/bob.json"; }
trap cleanup EXIT INT TERM
for _ in $(seq 1 60); do grep -q "(log " "$scratch/serve.out" 2>/dev/null && curl -fsS "$base/health" >/dev/null 2>&1 && break; sleep 0.5; done
log=$(sed -n 's/.*(log \(.*\))$/\1/p' "$scratch/serve.out")
[ -n "$log" ] || { echo "the scratch server did not start" >&2; exit 1; }

cat > "$scratch/home/Docs/plan.md" <<'MD'
# Launch plan

Markie RS opens this shared document and syncs it. Alice edits it together.

## Notes

- The quick brown fox ships on Friday.
- Carets show who is where.
MD
printf '# Agent notes\n\nAn agent puts this file in Markie Cloud through the bridge.\n' > "$scratch/home/Docs/notes.md"
echo '{"cloudSync":"always"}' > "$data/agent-permissions.json"
cat > "$scratch/drive.json" <<JSON
{"steps": [
  {"signIn": {"email": "$alice", "serverLog": "$log"}},
  {"delayMs": 1500},
  {"syncOn": true},
  {"delayMs": 1500},
  {"syncOff": "pause"},
  {"waitFor": "$scratch/shared"},
  {"syncOn": true},
  {"waitFor": "$scratch/stop"}
]}
JSON
rm -f "$scratch/shared" "$scratch/stop"
env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME="$scratch/home" MARKIE_RS_DATA_DIR="$data" MARKIE_RS_CLOUD_SERVER="$base" \
  MARKIE_RS_NIGHTLY=1 MARKIE_RS_COLLAB_DEBUG=1 MARKIE_RS_TEST_DRIVE="$scratch/drive.json" \
  "$repo/rust/target/debug/markie-rs" "$scratch/home/Docs/plan.md" >"$out/app.log" 2>&1 &
app=$!
wait_for() { for _ in $(seq 1 240); do grep -q "$1" "$out/app.log" && return 0; sleep 0.5; done; echo "timed out waiting for: $1" >&2; exit 1; }

wait_for "wait for $scratch/shared"
node "$here/accounts.mjs" signup "$base" "$log" "$bob" "Bob Tiptap" "$scratch/bob.token"
node "$here/accounts.mjs" signin "$base" "$log" "$alice" "$scratch/alice2.token"
node "$here/accounts.mjs" share "$base" "$scratch/alice2.token" plan.md "$bob" editor "$scratch/docid"
node "$here/accounts.mjs" accept "$base" "$scratch/bob.token" "$scratch/docid"
node "$here/accounts.mjs" bobjson "$base" "$scratch/docid" "$scratch/bob.token" "$scratch" "$scratch/bob.json"
touch "$scratch/shared"
wait_for "collab: ready"

(cd "$repo" && MARKIE_LIVE_PEER="$scratch/bob.json" npx vitest run --config rust/crates/markie-editor/interop/vitest.config.mts \
  rust/crates/markie-editor/interop/peer.test.ts >"$out/peer.out" 2>&1) &
peer=$!
for _ in $(seq 1 120); do [ -f "$scratch/peer-sees.json" ] && grep -q "Bob is typing" "$scratch/home/Docs/plan.md" && break; sleep 0.5; done
sleep 6

# Bob shares a document of his own with Alice, who has not accepted him:
# it waits in the Cloud page's Requests.
node "$here/accounts.mjs" put "$base" "$scratch/bob.token" from-bob.md "# From Bob"
node "$here/accounts.mjs" share "$base" "$scratch/bob.token" from-bob.md "$alice" editor "$scratch/bobdoc"

disc="$data/agent/agent-bridge-a65.json"
node "$here/agent.mjs" "$repo" "$disc" cloud_status "{\"path\":\"$scratch/home/Docs/plan.md\"}" >"$out/agent-status.json"
node "$here/agent.mjs" "$repo" "$disc" comments_add "{\"path\":\"$scratch/home/Docs/plan.md\",\"quote\":\"quick brown fox\",\"body\":\"Is Friday still the date?\",\"agent\":\"Claude Code\"}" >"$out/agent-comment.json"
node "$here/agent.mjs" "$repo" "$disc" comments_list "{\"path\":\"$scratch/home/Docs/plan.md\"}" >"$out/agent-comments-list.json"
node "$here/agent.mjs" "$repo" "$disc" cloud_sync "{\"path\":\"$scratch/home/Docs/notes.md\",\"agent\":\"Claude Code\"}" >"$out/agent-sync.json"
wait_for "1 share requests waiting"
sleep 3
node "$here/accounts.mjs" docs "$base" "$scratch/alice2.token" >"$out/server-docs.txt"
cp "$scratch/peer-sees.json" "$out/" ; cp "$scratch/home/Docs/plan.md" "$out/plan-after.md"
cp "$data"/doc-meta/*/comments.json "$out/comments.json" 2>/dev/null || true
sed -e 's/[0-9]\{6\}/<code>/g' "$log" >"$out/server.log"
echo "evidence in $out"
