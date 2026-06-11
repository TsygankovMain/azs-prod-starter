#!/usr/bin/env bash
set -euo pipefail

# When EMBEDDED_POSTGRES=false the container relies on an external managed DB.
# Exit immediately with success so supervisord considers this program done and
# moves on to starting the api program (priority 30). init-db.sh does the same.
EMBEDDED_POSTGRES="${EMBEDDED_POSTGRES:-true}"
if [ "${EMBEDDED_POSTGRES}" = "false" ]; then
  echo "[postgres] EMBEDDED_POSTGRES=false — skipping embedded PostgreSQL"
  exit 0
fi

PG_VERSION="${PG_VERSION:-$(ls /usr/lib/postgresql | sort -Vr | head -n 1)}"
DB_PORT="${DB_PORT:-5432}"
CONF_DIR="/etc/postgresql/${PG_VERSION}/main"
CONF_FILE="${CONF_DIR}/postgresql.conf"
DATA_DIR="/var/lib/postgresql/${PG_VERSION}/main"
RUN_DIR="/var/run/postgresql"

mkdir -p "${RUN_DIR}"
chmod 2775 "${RUN_DIR}"

if [ -f "${CONF_FILE}" ]; then
  sed -ri "s/^#?listen_addresses\s*=.*/listen_addresses = '127.0.0.1'/" "${CONF_FILE}"
  if grep -qE '^#?port\s*=' "${CONF_FILE}"; then
    sed -ri "s/^#?port\s*=.*/port = ${DB_PORT}/" "${CONF_FILE}"
  else
    echo "port = ${DB_PORT}" >> "${CONF_FILE}"
  fi
fi

exec "/usr/lib/postgresql/${PG_VERSION}/bin/postgres" \
  -D "${DATA_DIR}" \
  -c "config_file=${CONF_FILE}"
