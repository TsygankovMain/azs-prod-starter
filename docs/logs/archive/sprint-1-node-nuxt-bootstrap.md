# Sprint 1: Node + Nuxt Bootstrap

## PM Summary

Goal:
- Start the project on the selected stack: Node.js backend + Nuxt frontend.

Done:
- Docker Desktop is running.
- `make dev-node` profile was validated.
- Local `.env` was configured for Node backend and PostgreSQL.
- Cloudpub token was added to ignored local `.env`.
- Bitrix24 app `CLIENT_ID` and `CLIENT_SECRET` were added to ignored local `.env`.
- Containers were renamed to project-specific names to avoid conflicts with other local apps.
- Stack is running in detached mode.

Public URL:
- https://simply-staid-mollusk.cloudpub.ru

Verification:
- `https://simply-staid-mollusk.cloudpub.ru/install` returns HTTP 200.
- `http://localhost:8000/` returns HTTP 200 from Express.
- `http://localhost:8000/api/health` returns HTTP 401 without JWT, which is expected because the route is protected.
- Running containers: `azs-prod-frontend`, `azs-prod-api-node`, `azs-prod-cloudpub`, `azs-prod-starter-database-postgres-1`.

Business result:
- The app can now be opened through a public HTTPS URL and registered in Bitrix24 as a local app.

## Agent Notes

Local-only configuration:
- `.env` is ignored by Git.
- Do not commit Cloudpub token, Bitrix24 client secret, JWT secret, DB passwords, or job secret.
- Current backend proxy target: `SERVER_HOST='http://api-node:8000'`.
- Current public app URL: `VIRTUAL_HOST='https://simply-staid-mollusk.cloudpub.ru'`.

Tracked code changes:
- `docker-compose.yml` container names were changed from generic fixed names to project-specific names:
  - `azs-prod-frontend`
  - `azs-prod-cloudpub`
  - `azs-prod-api-php`
  - `azs-prod-api-python`
  - `azs-prod-api-node`

Commands used:

```bash
make dev-node
COMPOSE_PROFILES=frontend,node,cloudpub,db-postgres docker compose --env-file .env up --build -d
curl -i -sS https://simply-staid-mollusk.cloudpub.ru/install
curl -i -sS http://localhost:8000/
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Next sprint:
- Implement settings storage and smart-process field mapping.
