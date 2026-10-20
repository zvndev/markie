# Deploying the Markie API

## Your own server

To run your own Markie server on a VPS, follow
[docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md). It covers `init.sh`, `docker compose up -d`,
storage, mail, backups, restore and upgrades. The files in this folder are that kit.

## The official deployment (Markie Cloud)

Markie Cloud is the Railway `api` service, built from `server/Dockerfile`. Litestream runs inside
the same container and replicates age-encrypted to Backblaze B2. The auth schema migrates on every
boot, so a deploy needs no manual migration step.

Deploys, backups and rollback are in [docs/RELEASING.md](../docs/RELEASING.md), "API server deploy
and rollback".

The service runs as the official deployment because `MARKIE_OFFICIAL` is unset, which the server
reads as `1`. That keeps the release-manifest guards, the `/download` routes and the markiedocs.com
browser origins. Setting `MARKIE_OFFICIAL=1` explicitly changes nothing and is recommended. Never
set it to `0` there: that turns the download routes into redirects to markiedocs.com.

## Assets bucket

Pictures, video and audio synced with a document live in their own private
Backblaze B2 bucket on Markie Cloud, separate from the Litestream backup bucket.
A self-hosted server can share one bucket for both (see docs/SELF-HOSTING.md).

1. Create a private bucket (suggested name `markie-assets`).
2. Create an application key scoped to that bucket, with read and write.
3. Set the four variables on the Railway `api` service:

```bash
railway variables set "ASSETS_BUCKET=<bucket name>" --skip-deploys
railway variables set "ASSETS_ENDPOINT=<bucket's S3 endpoint, for example https://s3.us-west-004.backblazeb2.com>" --skip-deploys
railway variables set "ASSETS_KEY_ID=<application key id>" --skip-deploys
railway variables set "ASSETS_APP_KEY=<application key>" --skip-deploys
```

4. Prove the bucket answers before the server depends on it. The signed
   upload is never exercised by the normal test suite, so run the live round
   trip with the four values in the environment of this one command and
   nowhere else:

```bash
cd server && ASSETS_LIVE_TEST=1 \
  ASSETS_BUCKET=<bucket name> \
  ASSETS_ENDPOINT=<bucket's S3 endpoint> \
  ASSETS_KEY_ID=<application key id> \
  ASSETS_APP_KEY=<application key> \
  node --experimental-strip-types --test src/storage.test.ts
```

   It writes a small object as a stream, reads two bytes back out of the
   middle of it with a Range request, then deletes it. A pass shows
   `the real bucket round-trips` with a tick and `fail 0` at the end. A line
   reading `# SKIP` beside that name means `ASSETS_LIVE_TEST=1` did not reach
   the command, and nothing was proved. A failure here is the bucket refusing
   the request, which in production would mean every upload answers 403 and
   Markie sits on "media pending" without reporting an error.

5. Deploy from a clean export of the committed server, as described in
   docs/RELEASING.md, "API server deploy and rollback".

Until all four are set, the asset routes answer `503 {"error":"assets not
configured"}` and Markie shows "media pending" on the Cloud page rather than a failure.
Never write the values into the repo.

### One replica

Two things about assets are correct only because a single `api` process runs
them: the in-flight upload reservation that makes the 5 GB account cap bound
disk and bandwidth rather than only stored bytes, and the orphan sweep's
check-then-delete, which is safe because better-sqlite3 is synchronous and
Node is single-threaded. With two replicas each one reserves independently, so
the account cap becomes advisory, and a link racing another replica's sweep can
leave a `doc_assets` row whose `assets` row is gone. Scaling `api` past one
replica means moving both of those into the database first. It is a decision,
not a dial.
