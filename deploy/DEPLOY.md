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
