#!/bin/sh
# Write the .env for your own Markie server. Run once, then `docker compose up -d`.
#
# Asks for anything it was not given, generates the secrets itself, and never
# overwrites an existing .env or backup key. Secret values are written to the
# file and never printed. See docs/SELF-HOSTING.md.
#
#   sh init.sh --domain markie.example.org \
#     --s3-endpoint https://s3.eu-central-003.backblazeb2.com --s3-bucket my-markie \
#     --s3-access-key-id KEYID --s3-secret-access-key SECRET \
#     --resend-api-key re_xxx --mail-from 'Markie <markie@example.org>'
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$HERE/.env"
KEY_FILE=""

DOMAIN=""
SERVER_NAME=""
S3_ENDPOINT=""
S3_BUCKET=""
S3_ACCESS_KEY_ID=""
S3_SECRET_ACCESS_KEY=""
S3_REGION=""
S3_ASSETS_BUCKET=""
NO_STORAGE=""
RESEND_API_KEY=""
RESEND_BASE_URL=""
EMAIL_FROM=""
NO_MAIL=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
QUOTA_BYTES=""
AGE_KEY_FILE=""
INTERACTIVE=""
[ -t 0 ] && INTERACTIVE=1

usage() {
  cat <<'USAGE'
Usage: sh init.sh [options]

Required (asked for when missing and run from a terminal):
  --domain NAME                 the server's domain, e.g. markie.example.org

Storage (any S3-compatible bucket: Backblaze B2, Cloudflare R2, MinIO, AWS):
  --s3-endpoint URL             e.g. https://s3.eu-central-003.backblazeb2.com
  --s3-bucket NAME
  --s3-access-key-id ID
  --s3-secret-access-key SECRET
  --s3-region REGION            only if your provider needs one (R2: auto)
  --s3-assets-bucket NAME       keep media in a second bucket (optional)
  --no-storage                  no bucket: no media sync and NO off-site backup

Mail (optional; Resend or any Resend-compatible API):
  --resend-api-key KEY
  --resend-base-url URL         a Resend-compatible API instead of api.resend.com
  --mail-from 'Name <addr>'     sender address on a domain your provider verified
  --no-mail                     no mail: sign-up codes go to the server log

Optional:
  --name NAME                   shown in Markie when people add this server
  --google-client-id ID         Google sign-in
  --google-client-secret SECRET
  --quota-bytes N               storage quota per account, in bytes
  --age-key-file FILE           reuse an existing backup key (restoring onto a new server)
  --env-file FILE               where to write (default: .env beside this script)
  --non-interactive             never prompt; fail on anything missing
  -h, --help
USAGE
}

die() { echo "init.sh: $*" >&2; exit 1; }

need_value() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) need_value "$@"; DOMAIN=$2; shift 2 ;;
    --name) need_value "$@"; SERVER_NAME=$2; shift 2 ;;
    --s3-endpoint) need_value "$@"; S3_ENDPOINT=$2; shift 2 ;;
    --s3-bucket) need_value "$@"; S3_BUCKET=$2; shift 2 ;;
    --s3-access-key-id) need_value "$@"; S3_ACCESS_KEY_ID=$2; shift 2 ;;
    --s3-secret-access-key) need_value "$@"; S3_SECRET_ACCESS_KEY=$2; shift 2 ;;
    --s3-region) need_value "$@"; S3_REGION=$2; shift 2 ;;
    --s3-assets-bucket) need_value "$@"; S3_ASSETS_BUCKET=$2; shift 2 ;;
    --no-storage) NO_STORAGE=1; shift ;;
    --resend-api-key) need_value "$@"; RESEND_API_KEY=$2; shift 2 ;;
    --resend-base-url) need_value "$@"; RESEND_BASE_URL=$2; shift 2 ;;
    --mail-from) need_value "$@"; EMAIL_FROM=$2; shift 2 ;;
    --no-mail) NO_MAIL=1; shift ;;
    --google-client-id) need_value "$@"; GOOGLE_CLIENT_ID=$2; shift 2 ;;
    --google-client-secret) need_value "$@"; GOOGLE_CLIENT_SECRET=$2; shift 2 ;;
    --quota-bytes) need_value "$@"; QUOTA_BYTES=$2; shift 2 ;;
    --age-key-file) need_value "$@"; AGE_KEY_FILE=$2; shift 2 ;;
    --env-file) need_value "$@"; ENV_FILE=$2; shift 2 ;;
    --non-interactive) INTERACTIVE=""; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

KEY_FILE="$(dirname -- "$ENV_FILE")/markie-backup-key.txt"

# Never overwrite. An existing .env holds the only copy of secrets a running
# server depends on, and regenerating BETTER_AUTH_SECRET signs everyone out.
[ -e "$ENV_FILE" ] && die "$ENV_FILE already exists. Edit it by hand, or move it away first. Nothing was changed."

# ask VAR "prompt" [secret]: prompts only from a terminal, only when VAR is empty.
# The answer reaches VAR through eval, which shellcheck cannot follow.
# shellcheck disable=SC2034
ask() {
  [ -n "$INTERACTIVE" ] || return 0
  eval "current=\${$1}"
  [ -z "$current" ] || return 0
  printf '%s: ' "$2" >&2
  answer=""
  if [ "${3:-}" = secret ]; then
    stty -echo 2>/dev/null || true
    IFS= read -r answer || true
    stty echo 2>/dev/null || true
    echo >&2
  else
    IFS= read -r answer || true
  fi
  eval "$1=\$answer"
}

yes_no() { # yes_no "question" -> 0 for yes
  [ -n "$INTERACTIVE" ] || return 1
  printf '%s [y/N]: ' "$1" >&2
  IFS= read -r reply || reply=""
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

ask DOMAIN "Domain for this server (e.g. markie.example.org)"
DOMAIN=$(printf '%s' "$DOMAIN" | sed -e 's#^[a-zA-Z]*://##' -e 's#/.*$##' | tr '[:upper:]' '[:lower:]')
[ -n "$DOMAIN" ] || die "--domain is required"
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
  || die "'$DOMAIN' is not a domain name"

if [ -z "$NO_STORAGE" ]; then
  if [ -z "$S3_BUCKET" ] && [ -n "$INTERACTIVE" ]; then
    echo "Storage: an S3-compatible bucket holds the encrypted database backup and synced media." >&2
  fi
  ask S3_ENDPOINT "S3 endpoint URL"
  ask S3_BUCKET "Bucket name"
  ask S3_ACCESS_KEY_ID "Access key ID"
  ask S3_SECRET_ACCESS_KEY "Secret access key" secret
  if [ -z "$S3_ENDPOINT$S3_BUCKET$S3_ACCESS_KEY_ID$S3_SECRET_ACCESS_KEY" ]; then
    die "no storage given. Pass the --s3-* options, or --no-storage to run without off-site backups."
  fi
  for pair in "S3 endpoint:$S3_ENDPOINT" "bucket:$S3_BUCKET" "access key ID:$S3_ACCESS_KEY_ID" "secret access key:$S3_SECRET_ACCESS_KEY"; do
    [ -n "${pair#*:}" ] || die "storage is missing its ${pair%%:*}"
  done
  case "$S3_ENDPOINT" in http://*|https://*) ;; *) die "--s3-endpoint must start with https:// (or http:// for a local MinIO)" ;; esac
fi

if [ -z "$NO_MAIL" ] && [ -z "$RESEND_API_KEY" ] && [ -n "$INTERACTIVE" ]; then
  echo "Mail: sign-up codes and invitations go out through Resend or a Resend-compatible API." >&2
  echo "Leave the key empty to run without mail (codes are written to the server log instead)." >&2
  ask RESEND_API_KEY "Resend API key (optional)" secret
fi
if [ -n "$RESEND_API_KEY" ]; then
  NO_MAIL=""
  ask EMAIL_FROM "Sender, e.g. Markie <markie@$DOMAIN>"
  [ -n "$EMAIL_FROM" ] || EMAIL_FROM="Markie <noreply@$DOMAIN>"
else
  NO_MAIL=1
fi

if [ -n "$QUOTA_BYTES" ]; then
  printf '%s' "$QUOTA_BYTES" | grep -Eq '^[1-9][0-9]*$' || die "--quota-bytes must be a whole number of bytes"
fi
if [ -n "$GOOGLE_CLIENT_ID$GOOGLE_CLIENT_SECRET" ] && { [ -z "$GOOGLE_CLIENT_ID" ] || [ -z "$GOOGLE_CLIENT_SECRET" ]; }; then
  die "Google sign-in needs both --google-client-id and --google-client-secret"
fi

# Values are written single-quoted, which Docker Compose reads literally. A
# value that itself holds a quote or a line break cannot be written that way.
for value in "$DOMAIN" "$SERVER_NAME" "$S3_ENDPOINT" "$S3_BUCKET" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" \
  "$S3_REGION" "$S3_ASSETS_BUCKET" "$RESEND_API_KEY" "$RESEND_BASE_URL" "$EMAIL_FROM" "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET"; do
  case "$value" in *"'"*) die "a value contains a single quote, which .env cannot hold literally" ;; esac
  case "$value" in *'
'*) die "a value contains a line break" ;; esac
done

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

umask 077
AUTH_SECRET=$(random_hex)
[ ${#AUTH_SECRET} -ge 64 ] || die "could not generate a secret (no openssl and no /dev/urandom)"

# The backup key. age-keygen writes the private identity to a file; the public
# recipient is derived from it. Neither is echoed.
AGE_IDENTITY=""
AGE_RECIPIENT=""
AGE_NOTE=""
if [ -z "$NO_STORAGE" ]; then
  if [ -n "$AGE_KEY_FILE" ]; then
    [ -r "$AGE_KEY_FILE" ] || die "cannot read $AGE_KEY_FILE"
    KEY_SOURCE=$AGE_KEY_FILE
  elif [ -e "$KEY_FILE" ]; then
    echo "Using the existing backup key in $KEY_FILE." >&2
    KEY_SOURCE=$KEY_FILE
  elif command -v age-keygen >/dev/null 2>&1; then
    age-keygen -o "$KEY_FILE" 2>/dev/null
    KEY_SOURCE=$KEY_FILE
  else
    KEY_SOURCE=""
  fi
  if [ -n "$KEY_SOURCE" ]; then
    AGE_IDENTITY=$(grep '^AGE-SECRET-KEY-1' "$KEY_SOURCE" | head -n 1)
    [ -n "$AGE_IDENTITY" ] || die "$KEY_SOURCE does not contain an AGE-SECRET-KEY-1 line"
    if command -v age-keygen >/dev/null 2>&1; then
      AGE_RECIPIENT=$(printf '%s\n' "$AGE_IDENTITY" | age-keygen -y 2>/dev/null)
    else
      AGE_RECIPIENT=$(sed -n 's/^# public key: //p' "$KEY_SOURCE" | head -n 1)
    fi
    [ -n "$AGE_RECIPIENT" ] || die "could not read the public key for $KEY_SOURCE (install age to derive it)"
  else
    AGE_NOTE=missing
  fi
fi

q() { printf "'%s'" "$1"; }

{
  echo "# Markie server configuration, written by init.sh on $(date -u +%Y-%m-%d)."
  echo "# Private: this file holds every secret the server has. Never commit it."
  echo "MARKIE_DOMAIN=$(q "$DOMAIN")"
  echo "BETTER_AUTH_URL=$(q "https://$DOMAIN")"
  echo "BETTER_AUTH_SECRET=$(q "$AUTH_SECRET")"
  if [ -n "$SERVER_NAME" ]; then echo "MARKIE_SERVER_NAME=$(q "$SERVER_NAME")"; else echo "# MARKIE_SERVER_NAME='My Markie' (defaults to the domain)"; fi
  echo
  echo "# Storage: database backup under markie-db-age/, media under assets/."
  if [ -n "$NO_STORAGE" ]; then
    echo "# None configured: no media sync and no off-site backup. Add the four S3_* lines to enable both."
    echo "# S3_ENDPOINT='' S3_BUCKET='' S3_ACCESS_KEY_ID='' S3_SECRET_ACCESS_KEY=''"
  else
    echo "S3_ENDPOINT=$(q "$S3_ENDPOINT")"
    echo "S3_BUCKET=$(q "$S3_BUCKET")"
    echo "S3_ACCESS_KEY_ID=$(q "$S3_ACCESS_KEY_ID")"
    echo "S3_SECRET_ACCESS_KEY=$(q "$S3_SECRET_ACCESS_KEY")"
    if [ -n "$S3_REGION" ]; then echo "S3_REGION=$(q "$S3_REGION")"; else echo "# S3_REGION='auto'"; fi
    if [ -n "$S3_ASSETS_BUCKET" ]; then echo "S3_ASSETS_BUCKET=$(q "$S3_ASSETS_BUCKET")"; else echo "# S3_ASSETS_BUCKET='' (media in a bucket of its own)"; fi
    echo
    echo "# Backup encryption (age). The server will not replicate without both."
    echo "LITESTREAM_AGE_IDENTITY=$(q "$AGE_IDENTITY")"
    echo "LITESTREAM_AGE_RECIPIENT=$(q "$AGE_RECIPIENT")"
  fi
  echo
  echo "# Mail"
  if [ -n "$NO_MAIL" ]; then
    echo "# No mail: sign-up codes and invitations are written to the server log, and"
    echo "# you pass codes on by hand. Replace this line with RESEND_API_KEY to send mail."
    echo "MARKIE_MAIL_LOG='1'"
  else
    echo "RESEND_API_KEY=$(q "$RESEND_API_KEY")"
    echo "EMAIL_FROM=$(q "$EMAIL_FROM")"
    if [ -n "$RESEND_BASE_URL" ]; then echo "RESEND_BASE_URL=$(q "$RESEND_BASE_URL")"; else echo "# RESEND_BASE_URL='' (a Resend-compatible API)"; fi
  fi
  echo
  echo "# Google sign-in (optional). Redirect URI: https://$DOMAIN/api/auth/callback/google"
  if [ -n "$GOOGLE_CLIENT_ID" ]; then
    echo "GOOGLE_CLIENT_ID=$(q "$GOOGLE_CLIENT_ID")"
    echo "GOOGLE_CLIENT_SECRET=$(q "$GOOGLE_CLIENT_SECRET")"
  else
    echo "# GOOGLE_CLIENT_ID=''"
    echo "# GOOGLE_CLIENT_SECRET=''"
  fi
  echo
  echo "# Storage quota per account in bytes (optional; unset means unlimited)."
  if [ -n "$QUOTA_BYTES" ]; then echo "MARKIE_STORAGE_QUOTA_BYTES=$(q "$QUOTA_BYTES")"; else echo "# MARKIE_STORAGE_QUOTA_BYTES='5368709120'"; fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Wrote $ENV_FILE (secrets generated, not shown)."
if [ -n "$NO_STORAGE" ]; then
  echo "WARNING: no storage. The database lives only on this machine's Docker volume." >&2
elif [ "$AGE_NOTE" = missing ]; then
  cat >&2 <<'NOTE'

The backup key still needs to be made. age-keygen is not installed here.
  Install age (Debian/Ubuntu: apt install age; macOS: brew install age), then:
    age-keygen -o markie-backup-key.txt
  Put the AGE-SECRET-KEY-1... line in LITESTREAM_AGE_IDENTITY in .env, and the
  key printed by `age-keygen -y markie-backup-key.txt` in LITESTREAM_AGE_RECIPIENT.
The server refuses to start until both are set; it never backs up unencrypted.
NOTE
elif [ -z "$AGE_KEY_FILE" ]; then
  cat <<NOTE

Your backup key is in $KEY_FILE (and in .env).
Without it the backup cannot be restored. Store it in your password manager now,
then delete the file: rm "$KEY_FILE"
NOTE
fi
if [ -n "$NO_MAIL" ]; then
  echo "No mail: read sign-up codes with: docker compose logs markie-api | grep 'mail-log' -A 3"
fi
echo
echo "Next: point the DNS A record for $DOMAIN at this machine, then run: docker compose up -d"
