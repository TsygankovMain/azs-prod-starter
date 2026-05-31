# Sprint 7: Timeout And EXPIRED

## PM Summary

Goal:
- Automatically move overdue reports to EXPIRED and notify reviewer.

Done:
- Added timeout watcher service.
- Added manual endpoint:
  - `POST /api/jobs/timeout`
- Added overdue selector in reports storage layer:
  - deadline exists
  - deadline < now
  - status is not `done` and not `expired`
- Added lifecycle transition:
  - report status -> `expired`
- Added optional reviewer notification using configured reviewer user id.
- Added UI trigger on reviewer screen:
  - button "Проверить просрочки"

Business result:
- Reports that miss deadline are automatically closed into terminal EXPIRED status.
- Reviewer no longer depends on manual SQL/status edits to detect overdue reports.

## Agent Notes

Backend changes:
- `backends/node/api/src/dispatch/timeoutWatcher.js`
- `backends/node/api/src/dispatch/dispatchRoutes.js`
- `backends/node/api/src/dispatch/dispatchScheduler.js`
- `backends/node/api/src/dispatch/dispatchService.js`
- `backends/node/api/src/reports/reportsStore.js`
- `backends/node/api/server.js`

Frontend changes:
- `frontend/app/pages/reviewer.client.vue`
- `frontend/app/stores/api.ts`

Tests:
- `backends/node/api/tests/timeoutWatcher.test.js`

Verification:

```bash
cd backends/node/api && node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js tests/timeoutWatcher.test.js
docker exec azs-prod-api-node sh -lc 'node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js tests/timeoutWatcher.test.js'
docker exec azs-prod-frontend sh -lc 'pnpm exec eslint app/pages/reviewer.client.vue app/stores/api.ts app/pages/admin/[reportId].client.vue app/pages/index.client.vue'
docker exec azs-prod-api-node node -e "<manual report with past deadline + POST /api/jobs/timeout smoke>"
docker exec azs-prod-frontend sh -lc 'pnpm build'
```

Verification results:
- Unit tests pass (`12/12`).
- Timeout watcher test cases pass:
  - no photos/new status
  - partial/in_progress status
  - already done
  - already expired
- Manual timeout smoke:
  - before: `new`
  - after timeout run: `expired`
- Frontend lint/build pass for changed files.

Next sprint:
- Improve reviewer dashboard analytics (grouped counters, overdue slices, stage snapshots).
