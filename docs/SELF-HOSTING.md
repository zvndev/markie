# Run your own Markie server

Your own Markie server keeps your accounts, documents, sharing and collaboration on a machine you
control, with backups in a bucket you own. Markie can use it next to Markie Cloud.

Accounts live where the document lives. A document on your server is shared with people who sign
in to your server. Servers do not talk to each other.

## Requirements

- A small Linux VPS with Docker and the Compose plugin. A €4/month ARM machine is enough, for
  example a Hetzner CAX11 (2 vCPU, 4 GB) running Ubuntu 24.04. Install Docker with
  `curl -fsSL https://get.docker.com | sh`.
- A domain or subdomain for the server, such as `markie.example.org`.
- Ports 80 and 443 open to the internet. Caddy uses them to get and renew the TLS certificate.
- An S3-compatible bucket for the encrypted database backup and for synced media.
- Optional: a Resend account, or any Resend-compatible mail API, for sign-up codes and invitations.
- Optional: a Google OAuth client for "Sign in with Google".

## DNS

Create an `A` record for your domain pointing at the VPS's IPv4 address. Add an `AAAA` record too
if the VPS has IPv6.

Do this before the first start. Caddy asks Let's Encrypt for a certificate as soon as it boots, and
that only succeeds once the name resolves to your machine. Check with `dig +short markie.example.org`.

## Storage

The server writes two things to the bucket:

| Prefix | What | Encrypted |
| --- | --- | --- |
| `markie-db-age/` | Continuous Litestream backup of the database: accounts, documents, shares, comments | Yes, with your age key |
| `assets/` | Pictures, video and audio synced with documents | No. Keep the bucket private |

Make the bucket private and give the server a key that can read and write only that bucket. To
keep media in a second bucket, pass `--s3-assets-bucket` to `init.sh`.

### Backblaze B2

1. Create a private bucket.
2. Under Application Keys, create a key restricted to that bucket with read and write access.
3. The endpoint is on the bucket's page, for example `https://s3.eu-central-003.backblazeb2.com`.

Use the key ID as the access key ID and the application key as the secret.

### Cloudflare R2

1. Create a bucket.
2. Create an R2 API token with Object Read and Write, limited to that bucket.
3. The endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

Pass `--s3-region auto`.

### MinIO

Run MinIO yourself and create a bucket and an access key for Markie. The endpoint is MinIO's API
address, for example `https://minio.example.org` or `http://minio:9000` on a shared Docker
network.

A MinIO on the same VPS as Markie is not an off-site backup: losing the machine loses both. Run it
somewhere else, or use it only for testing. The `minio/minio` image on Docker Hub may no longer be
published, so follow MinIO's current install instructions.

## Install

```sh
git clone https://github.com/zvndev/markie.git
cd markie/deploy
sh init.sh
docker compose up -d
```

`init.sh` asks for the domain, your email address (the admin), the bucket and mail, then writes `deploy/.env`. It generates the
auth secret with `openssl` and the backup key with `age-keygen`. It never prints a secret, and it
never overwrites an existing `.env`.

Everything can be passed as flags instead, for scripts:

```sh
sh init.sh --non-interactive \
  --domain markie.example.org \
  --admin-email you@example.org \
  --name "Example Docs" \
  --s3-endpoint https://s3.eu-central-003.backblazeb2.com \
  --s3-bucket example-markie \
  --s3-access-key-id <key id> \
  --s3-secret-access-key <application key> \
  --resend-api-key <key> \
  --mail-from "Markie <markie@example.org>"
```

Run `sh init.sh --help` for every option.

If `age-keygen` is not installed, `init.sh` leaves the key empty and prints how to make one. Install
it with `apt install age` (or `brew install age`). The server refuses to start until the key is set,
because it never backs up unencrypted.

`docker compose up -d` builds the server image, starts it and Caddy, restores the database from the
bucket if the volume is empty, and migrates the schema. Check it:

```sh
curl https://markie.example.org/api/server-info
docker compose logs -f markie-api
```

The logs should end with `starting under litestream replication` and `markie-api listening on :8787`.

### Mail

With a Resend key, sign-up codes and invitations are emailed. The sender address must be on a
domain your provider has verified. To use a Resend-compatible API, pass `--resend-base-url`.

Without mail, `init.sh` sets `MARKIE_MAIL_LOG=1`. Every message is written to the server log
instead, and you pass sign-up codes on by hand:

```sh
docker compose logs markie-api | grep -A 3 'mail-log'
```

A code expires after 5 minutes. If it runs out, the person requests a new one and you read the log
again.

### Google sign-in

1. In the Google Cloud Console, create an OAuth client of type Web application.
2. Add the redirect URI `https://<your domain>/api/auth/callback/google`.
3. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, then run `docker compose up -d`.

## Add the server in Markie

In Markie, open Settings > Servers > Add a server and enter `https://markie.example.org`. Markie
reads `/api/server-info` to confirm it is a Markie server, then you sign in or create an account
there.

Markie Cloud stays available beside it. Each document belongs to one server.

## Who can sign up

A self-hosted server is invite-only by default. `MARKIE_SIGNUP` in `.env` decides:

| Value | Who can create an account |
| --- | --- |
| `invite` | The default. The admin, anyone invited to a document on this server, and addresses the admin allows |
| `open` | Anyone who can reach the server |
| `closed` | Nobody new. Existing accounts keep working |

The admin is the account for `MARKIE_ADMIN_EMAIL`, which `init.sh` asks for. With it set, that
address is the only one that can create the first account, so nobody can claim the server before
you do. Without it, the first account anyone creates becomes the admin. Sign up straight after
the first `docker compose up -d`.

The rule covers every way an account is made: email sign-up, a first sign-in by email code, and a
first Google sign-in. A refused sign-up answers HTTP 403 with
`{"code":"signup_invite_required"}`, or `signup_closed`, with a message to show. After a refused
Google sign-in, the browser page says the server is invite-only.

### The allowlist

To let someone in before anything is shared with them, allow their address. From a shell on the
server, in `deploy/`:

```sh
docker compose exec markie-api ./docker-entrypoint.sh signup allow friend@example.org
docker compose exec markie-api ./docker-entrypoint.sh signup list
docker compose exec markie-api ./docker-entrypoint.sh signup remove friend@example.org
```

The admin can do the same over HTTPS with their session token. In Markie this is the token the app
holds after you sign in; with curl, sign in first:

```sh
TOKEN=$(curl -s -D - -o /dev/null -H 'Content-Type: application/json' \
  -d '{"email":"you@example.org","password":"…"}' \
  https://markie.example.org/api/auth/sign-in/email | sed -n 's/^set-auth-token: //Ip' | tr -d '\r')

curl -H "Authorization: Bearer $TOKEN" https://markie.example.org/api/admin/signup-allowlist
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"friend@example.org"}' https://markie.example.org/api/admin/signup-allowlist
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://markie.example.org/api/admin/signup-allowlist/friend@example.org
```

Any other account gets 403 `{"error":"admin_required"}`. Removing an address stops it signing up;
it does not remove an account that already exists.

## Inviting guests

Share a document from Markie as usual. Your server emails the guest a link to read it in the
browser at your domain. The invitation is also what lets them create an account on an invite-only
server, so you never need to allow a guest by hand.

To edit, comment or keep the document in their Library, the guest adds your server in Markie and
creates an account with the invited address. The invitation is claimed once the address is
verified. Their account lives on your server, separate from any Markie Cloud account.

Without mail, share the document first, then ask the guest to create an account with that
address. Pass them their sign-up code from the log. They find the document once they are signed
in.

## Storage quota

Set `MARKIE_STORAGE_QUOTA_BYTES` in `.env` to cap what each account stores, for example
`5368709120` for 5 GiB, then `docker compose up -d`. Unset means unlimited.

The quota counts the current text of Markdown documents, uploaded media, and the current bytes of
Word, RTF and ODT documents the account owns. Version history is not counted. An editor's save is
counted against the document's owner.

A write that would take the account past the quota is refused with HTTP 413 and
`{"error":"storage_quota_exceeded"}`. Shrinking and deleting always work. `GET /api/account/usage`
returns `{ "usedBytes": …, "quotaBytes": … }` for the signed-in account.

## Backups and restore

Litestream copies every change to `markie-db-age/` within about a second, encrypted to your age
key. The key file `init.sh` wrote is `deploy/markie-backup-key.txt`.

Store the key in your password manager, then delete the file. From `deploy/`:

```sh
rm markie-backup-key.txt
```

All commands in this section and the next run from `deploy/`.

Without this key no backup can be read, by anyone, including you. The server keeps its own copy in
`.env`, which it needs to boot, so it is lost with the machine. Saving the whole `.env` as a secure
note is better still: it also keeps the auth secret, so people stay signed in after a rebuild.

### Check a backup

This restores a copy beside the live database and counts what is in it:

```sh
docker compose exec markie-api ./docker-entrypoint.sh backup restore -o /tmp/restore-check.db /data/markie.db
docker compose exec markie-api node -e 'const db=require("better-sqlite3")("/tmp/restore-check.db",{readonly:true});console.log(db.prepare("select count(*) n from user").get(), db.prepare("select count(*) n from docs").get())'
```

Always go through `./docker-entrypoint.sh backup`. It runs Litestream with this server's
configuration, which is where the decryption key comes from. `backup generations /data/markie.db`
and `backup snapshots /data/markie.db` list what the bucket holds.

### Restore onto a new machine

1. Point DNS at the new machine and install Docker.
2. Clone the repository and put back your saved `.env` in `deploy/`. If you only saved the key,
   write it to a file and run `sh init.sh --age-key-file <file>` with the same bucket settings.
3. Run `docker compose up -d`.

The volume is empty, so the server restores the newest backup before it starts. The logs show
`restoring snapshot` and then `starting under litestream replication`.

To restore to a moment in time, add `-timestamp 2026-10-20T12:00:00Z` to a `backup restore`.

## Upgrades and rollback

Take a snapshot on the volume, then rebuild from the newer code:

```sh
docker compose exec markie-api node -e 'require("better-sqlite3")("/data/markie.db").backup("/data/pre-upgrade.db").then(() => console.log("snapshot written"))'
git pull
docker compose up -d --build
```

The schema migrates on boot. Watch `docker compose logs markie-api` until it says
`markie-api listening`.

To roll back the code, check out the previous version and rebuild:

```sh
git checkout <previous commit or tag>
docker compose up -d --build
```

An older server ignores tables a newer one added, so this usually needs nothing else. To put the
data back as well, restore the snapshot while the server is stopped:

```sh
docker compose stop markie-api
docker compose run --rm --no-deps markie-api sh -c 'cp /data/pre-upgrade.db /data/markie.db && rm -f /data/markie.db-wal /data/markie.db-shm && touch /data/.litestream-new-generation'
docker compose start markie-api
```

The marker file starts a fresh backup generation from the restored database.

## Security notes

- `.env` holds every secret the server has. `init.sh` makes it readable by its owner only. Never
  commit it.
- Sign-up is invite-only unless you set `MARKIE_SIGNUP=open`. Anyone with an account can invite an
  address to a document, and that invitation lets the address sign up, so only give accounts to
  people you would let invite others. Set a storage quota as well.
- Sign-up requires a verified email address, exactly as on Markie Cloud. With `MARKIE_MAIL_LOG=1`
  the codes are in the server log, so treat access to the logs and to Docker as access to every
  account being created.
- The database backup is encrypted. Media in `assets/` is not encrypted by Markie, so keep the
  bucket private and the key scoped to it.
- Only Caddy is published. The API port, 8787, is reachable from the Docker network alone.
- The server trusts the Markie desktop app and its own domain for signed-in requests. It does not
  trust markiedocs.com or any other website.
- Download links on your server send people to `https://markiedocs.com/download`. Your server is
  not a release channel.
- Keep the VPS patched, and rebuild after `git pull` to pick up server fixes.

## Settings reference

`deploy/docker-compose.yml` sets `MARKIE_OFFICIAL=0`, `NODE_ENV=production` and `DB_PATH` itself.
Everything else lives in `.env`.

| Variable | Purpose |
| --- | --- |
| `MARKIE_DOMAIN` | The domain Caddy serves and gets a certificate for |
| `BETTER_AUTH_URL` | `https://<domain>`. Links, sign-in and `server-info` follow it |
| `BETTER_AUTH_SECRET` | Signs sessions. Changing it signs everyone out |
| `MARKIE_SERVER_NAME` | Name shown in Markie. Defaults to the domain |
| `MARKIE_SIGNUP` | `invite` (default here), `open` or `closed` |
| `MARKIE_ADMIN_EMAIL` | The admin's address, and the only possible first account |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The bucket. All four or none |
| `S3_REGION` | Only if the provider needs one. R2 uses `auto` |
| `S3_ASSETS_BUCKET` | Keep media in a separate bucket |
| `LITESTREAM_AGE_IDENTITY`, `LITESTREAM_AGE_RECIPIENT` | The backup key. Required with a bucket |
| `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_BASE_URL` | Mail |
| `MARKIE_MAIL_LOG` | `1` writes mail to the log instead. Self-hosted servers only |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `MARKIE_STORAGE_QUOTA_BYTES` | Per-account quota in bytes. Unset means unlimited |
| `MARKIE_WEB_ORIGINS` | Extra HTTPS origins allowed to make signed-in requests |
| `MARKIE_CLIENT_IP_HEADER` or `CLIENT_IP_HEADER` | The header your proxy sets to the client's address, for example `cf-connecting-ip` behind Cloudflare. Only that header is read. Unset uses `x-forwarded-for`, which Caddy sets |
| `ENABLE_CRONS` | `false` stops this server running its hourly cleanup of unused uploads. Unset runs it |
| `LF_SERVER_KEY` | A Little Friend secret server key (`lfs_...`). Set, the server reports its errors and request timings by route template to Little Friend. Unset sends nothing |
