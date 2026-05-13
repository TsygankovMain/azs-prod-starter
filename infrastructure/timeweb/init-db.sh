#!/usr/bin/env bash
set -euo pipefail

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-appdb}"
DB_USER="${DB_USER:-appuser}"
DB_PASSWORD="${DB_PASSWORD:-apppass}"
INIT_SQL_PATH="/opt/app/infrastructure/database/init.sql"
READY_FILE="/tmp/db-init.done"

attempt=0
until pg_isready -p "${DB_PORT}" -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge 60 ]; then
    echo "PostgreSQL is not ready after 60 attempts"
    exit 1
  fi
  sleep 1
done

role_exists="$(psql -p "${DB_PORT}" -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'")"
if [ "${role_exists}" = "1" ]; then
  psql -p "${DB_PORT}" -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE \"${DB_USER}\" WITH LOGIN PASSWORD '${DB_PASSWORD}';"
else
  psql -p "${DB_PORT}" -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE \"${DB_USER}\" WITH LOGIN PASSWORD '${DB_PASSWORD}';"
fi

db_exists="$(psql -p "${DB_PORT}" -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'")"
if [ "${db_exists}" != "1" ]; then
  createdb -p "${DB_PORT}" -U postgres -O "${DB_USER}" "${DB_NAME}"
fi

if [ -f "${INIT_SQL_PATH}" ]; then
  legacy_table_exists="$(psql -p "${DB_PORT}" -U postgres -d "${DB_NAME}" -tAc "SELECT to_regclass('public.bitrix24account') IS NOT NULL")"
  if [ "${legacy_table_exists}" != "t" ]; then
    psql -p "${DB_PORT}" -U postgres -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${INIT_SQL_PATH}"
  fi
fi

touch "${READY_FILE}"
echo "Database initialization completed"
