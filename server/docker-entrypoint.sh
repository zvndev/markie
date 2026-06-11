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

echo "migrating auth schema"
node --experimental-strip-types src/migrate.ts

if [ -n "$B2_BUCKET" ] && [ -n "$B2_KEY_ID" ]; then
  echo "starting under litestream replication"
  exec litestream replicate -config /etc/litestream.yml \
    -exec "node --experimental-strip-types src/index.ts"
fi

echo "starting (no B2 backup configured)"
exec node --experimental-strip-types src/index.ts
