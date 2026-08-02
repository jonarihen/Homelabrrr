#!/bin/sh
# Drop root before starting the API, without breaking installs whose db_data
# volume was created back when the container ran as root.
#
# A plain `USER node` in the Dockerfile is not enough: Docker seeds ownership
# from the image only when it creates a *new* named volume. On an existing
# deployment, /app/data inside db_data is already owned by uid 0, and the image's
# ownership is masked by the mount — so the backend would come back up unable to
# open db.sqlite (SQLITE_CANTOPEN) after the upgrade. The fix has to happen at
# runtime, once the volume is actually mounted, which means starting as root,
# correcting the ownership, and only then handing off to the unprivileged user.
#
# Net effect: PID 1 is root for a few milliseconds; node src/index.js — the
# process that holds decrypted PVE tokens and SSH keys in memory — is not.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  if ! chown -R node:node /app/data; then
    echo "[entrypoint] warning: could not take ownership of /app/data; the database may be read-only" >&2
  fi
  exec su-exec node "$@"
fi

# Already unprivileged (e.g. a `user:` override in compose) — nothing to fix up,
# and no way to chown anyway.
exec "$@"
