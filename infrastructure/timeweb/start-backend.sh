#!/usr/bin/env bash
set -euo pipefail

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-appdb}"
DB_USER="${DB_USER:-appuser}"
DB_PASSWORD="${DB_PASSWORD:-apppass}"
READY_FILE="/tmp/db-init.done"
EMBEDDED_POSTGRES="${EMBEDDED_POSTGRES:-true}"

if [ "${EMBEDDED_POSTGRES}" = "false" ]; then
  # External managed DB mode:
  # Skip the init-marker wait and go straight to checking that the external
  # host is reachable. We use pg_isready which only checks TCP connectivity
  # (not schema), so it works even before the app runs ensureSchema() calls.
  # 60-second retry window (~1 s each) is enough for a cold managed-DB wake.
  echo "[backend] EMBEDDED_POSTGRES=false — waiting for external DB ${DB_HOST}:${DB_PORT}"
  attempt=0
  until PGPASSWORD="${DB_PASSWORD}" pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -d "${DB_NAME}" -U "${DB_USER}" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "${attempt}" -ge 60 ]; then
      echo "Backend startup timeout: external database not reachable at ${DB_HOST}:${DB_PORT} after 60 s"
      exit 1
    fi
    sleep 1
  done
  echo "[backend] External DB is ready"
else
  # Embedded mode: wait for init-db.sh to complete (writes READY_FILE), then
  # confirm the local PG socket is accepting connections for our DB user.
  attempt=0
  until [ -f "${READY_FILE}" ]; do
    attempt=$((attempt + 1))
    if [ "${attempt}" -ge 90 ]; then
      echo "Backend startup timeout: database initialization marker not found"
      exit 1
    fi
    sleep 1
  done

  attempt=0
  until PGPASSWORD="${DB_PASSWORD}" pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -d "${DB_NAME}" -U "${DB_USER}" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "${attempt}" -ge 30 ]; then
      echo "Backend startup timeout: database is not ready for ${DB_USER}@${DB_NAME}"
      exit 1
    fi
    sleep 1
  done
fi

exec node server.js
