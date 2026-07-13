FROM node:22-alpine
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
RUN chmod +x docker-entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/markie.db
EXPOSE 8787
CMD ["./docker-entrypoint.sh"]
