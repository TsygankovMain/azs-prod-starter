# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
RUN npm install -g pnpm@9
COPY frontend/.npmrc ./
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# cache-bust: Timeweb buildkit переиспользует layer-кэш build-стадий и иначе кладёт
# в образ СТАРЫЙ фронт даже при изменённых исходниках (наблюдалось 2026-06-16:
# деплой 46eb0b7 «успешно», но в проде остался бандл от 3b77df2). Любое изменение
# строки ниже инвалидирует кэш с этой точки и форсит свежие COPY + generate.
# МЕНЯЙТЕ BUILD_REV при каждом деплое с изменениями фронта (дата + краткий SHA).
ARG BUILD_REV=2026-06-26-sprint9f
RUN echo "frontend build rev: ${BUILD_REV}"
COPY frontend ./
RUN pnpm run generate

FROM node:20-alpine AS api-builder
WORKDIR /app/backends/node/api
RUN npm install -g pnpm@9
COPY backends/node/api/.npmrc ./
COPY backends/node/api/package.json backends/node/api/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
# cache-bust (см. комментарий выше): форсит свежий COPY бэкенда вместо layer-кэша.
ARG BUILD_REV=2026-06-26-sprint9f
RUN echo "api build rev: ${BUILD_REV}"
COPY backends/node/api ./

FROM node:20-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV DB_HOST=127.0.0.1
ENV DB_PORT=5432
ENV DB_NAME=appdb
ENV DB_USER=appuser
ENV DB_PASSWORD=apppass
ENV DB_TYPE=postgresql
ENV PORT=8000

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    nginx \
    postgresql \
    postgresql-contrib \
    supervisor \
  && rm -rf /var/lib/apt/lists/*

RUN rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf

WORKDIR /opt/app

COPY --from=frontend-builder /app/frontend/.output/public /var/www/frontend
COPY --from=api-builder /app/backends/node/api /opt/app/backends/node/api
COPY infrastructure/database/init.sql /opt/app/infrastructure/database/init.sql
COPY infrastructure/timeweb/nginx.conf /etc/nginx/nginx.conf
COPY infrastructure/timeweb/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY infrastructure/timeweb/start-postgres.sh /usr/local/bin/start-postgres.sh
COPY infrastructure/timeweb/init-db.sh /usr/local/bin/init-db.sh
COPY infrastructure/timeweb/start-backend.sh /usr/local/bin/start-backend.sh
COPY infrastructure/timeweb/timeweb-root-ca.crt /opt/app/infrastructure/timeweb/timeweb-root-ca.crt

RUN chmod +x \
  /usr/local/bin/start-postgres.sh \
  /usr/local/bin/init-db.sh \
  /usr/local/bin/start-backend.sh

EXPOSE 8080

# nginx listens on 8080 and proxies /api/ to Node on port 8000.
# Checking through nginx reflects the full stack (proxy + app).
# curl is already present in the apt-get install above.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS --max-time 3 http://127.0.0.1:8080/api/healthz || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
