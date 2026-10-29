FROM node:22-alpine
# Kamal matches an image to its service by this label.
LABEL service="markie-api"
WORKDIR /app

# Litestream (continuous SQLite backup to B2; no-op until B2_* env is set)
RUN ARCH=$(uname -m) && case "$ARCH" in \
      x86_64) LSA=amd64 ;; \
      aarch64) LSA=arm64 ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && wget -qO- https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${LSA}.tar.gz \
    | tar -xz -C /usr/local/bin

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY download-manifest.json ./download-manifest.json
COPY litestream.yml /etc/litestream.yml
COPY docker-entrypoint.sh ./
# The server runs as `markie`, uid and gid 10002, never as root. /data belongs
# to it, so a new Docker volume starts out writable. A volume made by an older
# image is root-owned: chown it to 10002:10002 once before upgrading.
RUN chmod +x docker-entrypoint.sh \
 && addgroup -S -g 10002 markie \
 && adduser -S -D -H -u 10002 -G markie -h /nonexistent -s /sbin/nologin markie \
 && mkdir -p /data && chown markie:markie /data

ENV NODE_ENV=production
ENV DB_PATH=/data/markie.db
# The build Little Friend's fault reports name (src/little-friend.ts): the
# image tag, passed with --build-arg LF_RELEASE=<tag>. Empty falls back to
# KAMAL_VERSION, which Kamal sets to the same tag.
ARG LF_RELEASE=""
ENV LF_RELEASE=${LF_RELEASE}
EXPOSE 8787
USER 10002:10002
CMD ["./docker-entrypoint.sh"]
