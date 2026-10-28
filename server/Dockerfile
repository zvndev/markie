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

# Litestream 0.5.17 for hosted Markie on ZVN's boxes, where it can run inside
# the app's own container (a Kata VM) instead of on the host. Pinned, and the
# tarball is checked against the sha256 in the release's checksums.txt. It is
# off unless LITESTREAM_IN_VM=1 (litestream-vm/init), so self-hosting and the
# 0.3.13 backup above are unchanged.
ARG TARGETARCH
RUN case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) LSA=x86_64; LSSUM=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d ;; \
      arm64|aarch64) LSA=arm64; LSSUM=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 ;; \
      *) echo "unsupported arch" && exit 1 ;; \
    esac \
 && wget -qO /tmp/litestream.tar.gz https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-${LSA}.tar.gz \
 && echo "${LSSUM}  /tmp/litestream.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/litestream-vm \
 && tar -xzf /tmp/litestream.tar.gz -C /opt/litestream-vm litestream \
 && rm /tmp/litestream.tar.gz
COPY litestream-vm/ /opt/litestream-vm/
RUN chown 0:0 /opt/litestream-vm/litestream \
 && chmod 0755 /opt/litestream-vm/init /opt/litestream-vm/litestream \
 && chmod 0644 /opt/litestream-vm/lease-check.mjs /opt/litestream-vm/litestream.yml
# The replica path the in-VM Litestream writes: <prefix>/markie-api/markie.db.
ENV LITESTREAM_APP=markie-api
ENV LITESTREAM_DB=/data/markie.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY download-manifest.json ./download-manifest.json
COPY litestream.yml /etc/litestream.yml
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/markie.db
# The build Little Friend's fault reports name (src/little-friend.ts): the
# image tag, passed with --build-arg LF_RELEASE=<tag>. Empty falls back to
# KAMAL_VERSION, which Kamal sets to the same tag.
ARG LF_RELEASE=""
ENV LF_RELEASE=${LF_RELEASE}
EXPOSE 8787
# init runs the entrypoint as it is unless LITESTREAM_IN_VM=1, and then
# under Litestream as PID 1 (litestream-vm/init).
CMD ["/opt/litestream-vm/init", "./docker-entrypoint.sh"]
