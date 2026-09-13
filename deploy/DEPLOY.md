# Deploying the Markie API

One small ARM VPS runs everything: the API (Hono + better-auth + SQLite),
Caddy (TLS), and Litestream (continuous SQLite backup to Backblaze B2).
Estimated cost: ~€4/mo VPS + pennies of B2 storage.

## What Kirby provisions (one time)

1. **Hetzner** — CAX11 (ARM, 2 vCPU / 4 GB), Ubuntu 24.04. Install Docker
   (`curl -fsSL https://get.docker.com | sh`).
2. **DNS** — A record for the API host (suggest `api.markiedocs.com`
   until a product domain is chosen) → the VPS IP.
3. **Backblaze B2** — create a bucket (private) + an app key with access
   to it. Note the S3 endpoint for the bucket's region.
4. **Resend** — account + API key; verify the sending domain.
5. **Google OAuth** — Google Cloud Console → OAuth client (Web). Authorized
   redirect URI: `https://<api-host>/api/auth/callback/google`.

## Deploy

```bash
# on the VPS
git clone https://github.com/zvndev/markie.git && cd markie/deploy
cp ../server/.env.example .env
# edit .env:
#   BETTER_AUTH_URL=https://<api-host>
#   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
#   RESEND_API_KEY / EMAIL_FROM
#   B2_ENDPOINT / B2_BUCKET / B2_KEY_ID / B2_APP_KEY
sed -i 's/api.markie.example.com/<api-host>/' Caddyfile
docker compose up -d --build
# first run only: create the auth schema
docker compose exec markie-api npx @better-auth/cli@latest migrate --config src/auth.ts -y
curl https://<api-host>/health   # → {"ok":true,...}
```

## Point the app at production

In Markie: Settings → Advanced → server URL → `https://<api-host>`.
(Shipping this as the default is a one-line change in
`src/lib/auth-client.ts` `DEFAULT_SERVER` once the host exists.)

## Restore drill (do this once after first deploy)

```bash
docker compose stop markie-api
docker compose run --rm litestream restore -config /etc/litestream.yml /data/markie.db
docker compose start markie-api
```

## Assets bucket

Pictures, video and audio synced with a document live in their own private
Backblaze B2 bucket, separate from the Litestream backup bucket above.

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

5. Deploy:

```bash
railway up server --path-as-root --service api --environment production --ci
```

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
