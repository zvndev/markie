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

if [ -n "$B2_BUCKET" ] && [ -n "$B2_KEY_ID" ]; then
  echo "starting under litestream replication"
  exec litestream replicate -config /etc/litestream.yml \
    -exec "node --experimental-strip-types src/index.ts"
fi

echo "starting (no B2 backup configured)"
exec node --experimental-strip-types src/index.ts
