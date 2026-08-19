FROM node:26.5.1-alpine3.24

WORKDIR /app

COPY package*.json ./
# Production dependencies are all pure JS now (pg, bcryptjs, ssh2, ...) — no
# native build toolchain needed. better-sqlite3 is a devDependency (used only
# by the one-time SQLite import tool, which runs in a throwaway container), but
# drizzle-orm declares it as an optional peer, so npm keeps it under --omit=dev.
# --ignore-scripts skips its node-gyp build (the package is never imported at
# runtime) and ssh2's optional native accelerators (it falls back to pure JS),
# so no Python/make/g++ is required. puttygen migrates legacy PuTTY SSH keys;
# postgresql17-client provides pg_dump/pg_restore for the encrypted backup
# pipeline (must match the postgres:17 server major in docker-compose.yml).
RUN npm ci --omit=dev --ignore-scripts \
 && apk add --no-cache putty postgresql17-client

COPY src ./src
COPY drizzle ./drizzle

# /app/data (legacy SQLite import mount) and the backup staging dirs are owned
# by the unprivileged runtime user. The server no longer writes an on-disk
# database, so there is no root-owned db file to fix up at runtime — the process
# that holds decrypted secrets runs as node from PID 1.
RUN mkdir -p /app/data /app/backups /app/backups-offsite \
 && chown -R node:node /app/data /app/backups /app/backups-offsite

USER node

EXPOSE 3000

CMD ["node", "src/index.ts"]
