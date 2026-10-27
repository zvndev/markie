# Deploying the Markie API

## Your own server

To run your own Markie server on a VPS, follow
[docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md). It covers `init.sh`, `docker compose up -d`,
storage, mail, backups, restore and upgrades. The files in this folder are that kit.

## The official deployment (Markie Cloud)

Markie Cloud is the Kamal app `markie-api` on ZVN's own boxes (`zvn-apps-a` writer, `zvn-apps-b`
standby), behind Cloudflare at `https://api.markiedocs.com`. It is built from `server/Dockerfile`.
Litestream runs on the host and replicates to Backblaze B2. The image's own Litestream stays off.
The auth schema migrates on every boot, so a deploy needs no manual migration step.

Config, secrets, deploys, failover, backups and rollback live in the private `ZVN-DEV/zvn-infra`
repo: `kamal/apps/markie-api/` and `docs/migrations/markie-api.md`.

Markie Cloud runs as the official deployment: `MARKIE_OFFICIAL` unset, which the server reads as
`1`. That keeps the release-manifest guards, the `/download` routes and the markiedocs.com
browser origins. Setting `MARKIE_OFFICIAL=1` explicitly changes nothing and is recommended. Never
set it to `0` there: that turns the download routes into redirects to markiedocs.com.

## Assets bucket

Pictures, video and audio synced with a document live in their own private
Backblaze B2 bucket on Markie Cloud, separate from the Litestream backup bucket.
A self-hosted server can share one bucket for both (see docs/SELF-HOSTING.md).

1. Create a private bucket (suggested name `markie-assets`).
2. Create an application key scoped to that bucket, with read and write.
3. Set `ASSETS_BUCKET`, `ASSETS_ENDPOINT` (the bucket's S3 endpoint, for example
   `https://s3.us-west-004.backblazeb2.com`), `ASSETS_KEY_ID` and `ASSETS_APP_KEY` in the
   `markie-api` Kamal config in zvn-infra. The bucket and endpoint are plain env, the two key
   values are secrets.

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

5. Deploy `markie-api` from zvn-infra.

Until all four are set, the asset routes answer `503 {"error":"assets not
configured"}` and Markie shows "media pending" on the Cloud page rather than a failure.
Never write the values into the repo.

### One replica

Two things about assets are correct only because a single API process runs
them: the in-flight upload reservation that makes the 5 GB account cap bound
disk and bandwidth rather than only stored bytes, and the orphan sweep's
check-then-delete, which is safe because better-sqlite3 is synchronous and
Node is single-threaded. With two replicas each one reserves independently, so
the account cap becomes advisory, and a link racing another replica's sweep can
leave a `doc_assets` row whose `assets` row is gone. Scaling the API past one
replica means moving both of those into the database first. It is a decision,
not a dial.
