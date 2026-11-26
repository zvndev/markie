#!/usr/bin/env bash
# The Google Docs spike, against the real Google. Kirby runs it by hand once
# the Desktop OAuth client exists (docs/rust-port/GOOGLE-DOCS.md). Never in CI.
#
#   MARKIE_GOOGLE_DESKTOP_CLIENT_ID=... [MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET=...] \
#     rust/scripts/google-spike.sh [--out <folder>] [--write-test]
#
# It opens Google's Picker in your browser, then prints a report: whether the
# Picker flow works, whether a folder pick covers its Docs (and Docs added
# later), what each Doc converts to, what Google's Markdown and .docx exports
# keep, and whether changes.list shows only picked files. It only reads from
# Google, keeps the grant in memory (never the Keychain) and revokes it at the
# end. --out saves the converted Markdown, Google's exports and each Doc's
# JSON to that folder, for comparing by eye; keep it out of the repo.
#
# --write-test (opt-in) also makes a new Doc named "Markie sync test", runs
# two-way sync against it both ways, with a collaborator edit during a write,
# a conflict and a suggestion, reports, and moves that Doc to the trash at the
# end. It refuses to write to any other Doc. Without it the spike only reads.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -n "${MARKIE_GOOGLE_DESKTOP_CLIENT_ID:-}" ]] || { echo "Set MARKIE_GOOGLE_DESKTOP_CLIENT_ID first." >&2; exit 2; }
exec cargo run --quiet --release -p markie-google --example google_spike -- "$@"
