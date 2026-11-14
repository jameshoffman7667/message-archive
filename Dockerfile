FROM node:20.19-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20.19-alpine
LABEL org.opencontainers.image.title="message-archive" \
      org.opencontainers.image.description="Archive and viewer for Android SMS/MMS/RCS backups" \
      org.opencontainers.image.source="https://github.com/jameshoffman7667/message-archive"
RUN apk add --no-cache tini
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data FILES_DIR=/files INBOX_DIR=/inbox TZ=America/Toronto
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# /data: SQLite (fast disk). /files: media store (pool). /inbox: backup drop folder (dump_truck share).
# All three must be writable by uid 1000 / gid 100.
RUN mkdir -p /data /files /inbox && chown 1000:100 /data /files /inbox
USER 1000:100
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz | grep -q '"status":"ok"' || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
