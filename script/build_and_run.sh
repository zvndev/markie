#!/usr/bin/env bash
set -euo pipefail
MARKIE_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MARKIE_PROJECT_DIR"
# Explicit Run clicks opt into a real window. Do not terminate an existing
# preview by process name: it may contain the user's unsaved documents.
exec node scripts/desktop-preview.mjs build-and-run "${1:-mac-$(uname -m | sed 's/x86_64/x64/')}"
