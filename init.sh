#!/usr/bin/env bash
# Boot and smoke-test the Markie repo. Run at the start of every long-agent-loop wakeup.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Prefer whatever node is already on PATH; fall back to common install roots so
# a bare shell (cron, an agent runner) still finds one.
if ! command -v node >/dev/null 2>&1; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "init.sh: node and npm must be available on PATH" >&2
  exit 127
fi

# Match package.json engines: Node 22+. Pinning an exact major locked out
# contributors on newer LTS releases for no reason.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "init.sh: Node 22 or newer is required; found $(node -v)" >&2
  exit 127
fi

if [[ ! -d node_modules ]]; then
  npm ci
fi

if [[ ! -d server/node_modules ]]; then
  (cd server && npm ci)
fi

npm test
node --test mcp/lib.test.mjs
(cd server && npm test)
npm run lint
npm run build
