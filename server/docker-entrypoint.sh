#!/bin/sh
# Boot: optional Litestream restore/replicate (when B2 creds are set),
# idempotent auth-schema migration, then the API.
set -e

DB_PATH="${DB_PATH:-/data/markie.db}"
export DB_PATH

if [ -n "$B2_BUCKET" ] && [ -n "$B2_KEY_ID" ]; then
  echo "litestream: B2 configured — restoring if volume is empty"
  litestream restore -if-db-not-exists -if-replica-exists \
    -config /etc/litestream.yml "$DB_PATH" || true
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
if [ -f "$NEW_GENERATION_MARKER" ]; then
  echo "litestream: starting a new generation"
  rm -rf "$LITESTREAM_META" "$NEW_GENERATION_MARKER"
fi

if [ -n "$B2_BUCKET" ] && [ -n "$B2_KEY_ID" ]; then
  echo "starting under litestream replication"
  exec litestream replicate -config /etc/litestream.yml \
    -exec "node --experimental-strip-types src/index.ts"
fi

echo "starting (no B2 backup configured)"
exec node --experimental-strip-types src/index.ts
