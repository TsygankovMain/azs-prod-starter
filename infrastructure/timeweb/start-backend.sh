#!/usr/bin/env bash
set -euo pipefail

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-appdb}"
DB_USER="${DB_USER:-appuser}"
DB_PASSWORD="${DB_PASSWORD:-apppass}"
READY_FILE="/tmp/db-init.done"

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

exec node server.js
