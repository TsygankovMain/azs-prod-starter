# Sprint 8: Reviewer Dashboard

## PM Summary

Goal:
- Improve reviewer workspace with status analytics and faster report triage.

Done:
- Added backend summary endpoint:
  - `GET /api/reports/summary`
- Added aggregated metrics:
  - `total`
  - `open`
  - `done`
  - `expired`
  - `failed`
  - `overdue`
  - `byStatus`
- Added reviewer KPI cards at top of screen.
- Added quick status filters:
  - all
  - `new`
  - `in_progress`
  - `done`
  - `expired`
  - `failed`
- Added parallel loading of report list and summary to keep dashboard responsive.

Business result:
- Reviewer gets immediate visibility of operational workload and overdue pressure.
- Common status checks now require one click instead of manual filter setup.

## Agent Notes

Backend changes:
- `backends/node/api/src/reports/reportsStore.js`
- `backends/node/api/src/reports/reportsRoutes.js`

Frontend changes:
- `frontend/app/stores/api.ts`
- `frontend/app/pages/reviewer.client.vue`

Verification:

```bash
docker exec azs-prod-api-node sh -lc 'cd /app && node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js tests/timeoutWatcher.test.js'
docker exec azs-prod-frontend sh -lc 'cd /app && pnpm exec eslint app/pages/reviewer.client.vue app/stores/api.ts'
```

Verification results:
- Backend tests pass (`12/12`).
- Frontend lint passes for changed files.
- Dashboard summary and list are loaded in one request cycle from UI perspective.

Next sprint:
- Sprint 9 manual trigger hardening:
  - enforce idempotency against auto slot keys
  - improve reviewer feedback on manual trigger collisions
  - keep lifecycle parity with auto dispatch
