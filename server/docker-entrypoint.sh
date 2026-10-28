#!/bin/sh
# Boot: optional Litestream restore/replicate (when backup storage is set),
# idempotent auth-schema migration, then the API.
#
#   ./docker-entrypoint.sh                     boot the server (the default)
#   ./docker-entrypoint.sh signup list|allow|remove [email]   the sign-up allowlist
#   ./docker-entrypoint.sh backup <command>    run `litestream <command>` with
#                                              this server's config, for example
#                                              `backup generations /data/markie.db`
set -e

DB_PATH="${DB_PATH:-/data/markie.db}"
export DB_PATH
LITESTREAM_CONFIG=/etc/litestream.yml

# The sign-up allowlist (MARKIE_SIGNUP=invite), against the live database.
# Needs no backup storage, so it runs before any of the checks below.
if [ "$1" = "signup" ]; then
  shift
  exec node --experimental-strip-types src/signup-admin.ts "$@"
fi

# Generic S3 names (any provider) win; the B2_* names are what the live
# deployment sets and what litestream.yml reads, so the generic ones are copied
# into them. A half-set generic configuration is an error, not a silent "no
# backup", because the person who set three of four names meant to have one.
if [ -n "${S3_ENDPOINT}${S3_BUCKET}${S3_ACCESS_KEY_ID}${S3_SECRET_ACCESS_KEY}" ]; then
  missing=""
  [ -n "$S3_ENDPOINT" ] || missing="$missing S3_ENDPOINT"
  [ -n "$S3_BUCKET" ] || missing="$missing S3_BUCKET"
  [ -n "$S3_ACCESS_KEY_ID" ] || missing="$missing S3_ACCESS_KEY_ID"
  [ -n "$S3_SECRET_ACCESS_KEY" ] || missing="$missing S3_SECRET_ACCESS_KEY"
  if [ -n "$missing" ]; then
    echo "error: S3 storage is only partly configured. Also set:$missing" >&2
    exit 1
  fi
  B2_ENDPOINT="$S3_ENDPOINT"
  B2_BUCKET="$S3_BUCKET"
  B2_KEY_ID="$S3_ACCESS_KEY_ID"
  B2_APP_KEY="$S3_SECRET_ACCESS_KEY"
  B2_REGION="${S3_REGION:-}"
  export B2_ENDPOINT B2_BUCKET B2_KEY_ID B2_APP_KEY B2_REGION
fi

BACKUP=""
if [ -n "$B2_BUCKET" ] && [ -n "$B2_KEY_ID" ]; then
  BACKUP=1
fi

# LITESTREAM_IN_VM=1: Litestream 0.5 already runs around this script
# (litestream-vm/init) and replicates LITESTREAM_DB. A second Litestream on the
# same file, or a different file, would be a silent mess. Refuse both.
if [ "${LITESTREAM_IN_VM:-}" = "1" ] && [ "$1" != "backup" ]; then
  if [ -n "$BACKUP" ]; then
    echo "error: LITESTREAM_IN_VM=1 and the B2_*/S3_* backup are both set. Use one." >&2
    exit 1
  fi
  if [ "$LITESTREAM_DB" != "$DB_PATH" ]; then
    echo "error: LITESTREAM_IN_VM=1 replicates $LITESTREAM_DB, but DB_PATH is $DB_PATH." >&2
    exit 1
  fi
fi

# litestream.yml encrypts every replica with age. Without both halves of the
# key Litestream would not start, and the container would crash-loop with a
# parse error that names neither variable. Say what is wrong instead, and never
# fall back to replicating in plaintext.
if [ -n "$BACKUP" ] && { [ -z "$LITESTREAM_AGE_IDENTITY" ] || [ -z "$LITESTREAM_AGE_RECIPIENT" ]; }; then
  echo "error: backup storage is configured but LITESTREAM_AGE_IDENTITY and LITESTREAM_AGE_RECIPIENT are not both set." >&2
  echo "error: Markie only replicates the database encrypted. Create a key with 'age-keygen' (deploy/init.sh does this)," >&2
  echo "error: put the AGE-SECRET-KEY-1... line in LITESTREAM_AGE_IDENTITY and its age1... public key in LITESTREAM_AGE_RECIPIENT." >&2
  exit 1
fi

if [ "$1" = "backup" ]; then
  shift
  if [ -z "$BACKUP" ]; then
    echo "error: no backup storage is configured (set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)." >&2
    exit 1
  fi
  if [ $# -eq 0 ]; then
    echo "usage: $0 backup <litestream command> [args], e.g. backup generations $DB_PATH" >&2
    exit 2
  fi
  command="$1"
  shift
  exec litestream "$command" -config "$LITESTREAM_CONFIG" "$@"
fi

if [ -n "$BACKUP" ]; then
  echo "litestream: backup storage configured — restoring if volume is empty"
  litestream restore -if-db-not-exists -if-replica-exists \
    -config "$LITESTREAM_CONFIG" "$DB_PATH" || true
fi

# Must run BEFORE the auth migration. better-auth 1.7 refuses to add its new
# required `issuer` column to a populated `account` table, which means an
# existing deployment cannot boot at all until every row has a correct value.
# The refusal is right; this supplies what it is asking for.
echo "backfilling account issuer if needed"
node --experimental-strip-types src/backfill-issuer.ts

echo "migrating auth schema"
node --experimental-strip-types src/migrate.ts

# Fold the WAL into the database file and truncate it while nothing else has
# the file open. Once Litestream is running it holds a read lock, which leaves
# the WAL at its high-water mark with stale frames in it, and a document purged
# from the cloud must not outlive its row in there.
if [ -f "$DB_PATH" ]; then
  echo "checkpointing wal"
  node -e 'const db = require("better-sqlite3")(process.env.DB_PATH); console.log(JSON.stringify(db.pragma("wal_checkpoint(TRUNCATE)"))); db.close();'
fi

# One-shot operator switch: `touch /data/.litestream-new-generation` before a
# deploy and Litestream starts a fresh generation, so the next snapshot is taken
# from the database as it is now rather than replayed from its history. The
# marker is consumed, so it cannot fire twice.
LITESTREAM_META="$(dirname "$DB_PATH")/.$(basename "$DB_PATH")-litestream"
NEW_GENERATION_MARKER="$(dirname "$DB_PATH")/.litestream-new-generation"
# Not with LITESTREAM_IN_VM=1: there the same directory is the running
# Litestream 0.5's own state.
if [ -f "$NEW_GENERATION_MARKER" ] && [ "${LITESTREAM_IN_VM:-}" != "1" ]; then
  echo "litestream: starting a new generation"
  rm -rf "$LITESTREAM_META" "$NEW_GENERATION_MARKER"
fi

if [ -n "$BACKUP" ]; then
  echo "starting under litestream replication"
  exec litestream replicate -config "$LITESTREAM_CONFIG" \
    -exec "node --experimental-strip-types src/index.ts"
fi

echo "starting (no off-site backup configured: the database lives only on this volume)"
exec node --experimental-strip-types src/index.ts
