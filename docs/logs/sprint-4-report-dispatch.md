# Sprint 4: Report Dispatch

## PM Summary

Goal:
- Add backend dispatch flow that can create report requests by schedule, avoid duplicates, and notify responsible users.

Done:
- Added protected route:
  - `POST /api/jobs/dispatch`
- Added idempotency persistence:
  - `dispatch_log` table with unique key `(slot_key, azs_id)`
- Added scheduler and jitter foundation:
  - `node-cron` integration (lazy import)
  - jitter in range `[-dispatchJitterMinutes, +dispatchJitterMinutes]`
- Added report and notify integration layer:
  - `crm.item.add` for report creation
  - `im.notify.personal.add` for push/notification
- Added tests:
  - slot key calculation
  - jitter boundaries
  - duplicate protection
  - dispatch summary behavior

Business result:
- Backend now has a deterministic dispatch contract for auto and manual trigger flows.
- Duplicate protection is implemented at DB level, not only in memory.

Important note:
- Current frontend home page is still starter demo UI by design.
- Sprint 4 is backend-only infrastructure and does not replace the demo page.

## Agent Notes

New backend modules:
- `src/dispatch/dispatchService.js`
- `src/dispatch/dispatchLogStore.js`
- `src/dispatch/bitrixRestClient.js`
- `src/dispatch/dispatchRoutes.js`
- `src/dispatch/dispatchScheduler.js`
- `src/dispatch/dispatchCandidatesFileStore.js`

Server integration:
- Mounted `app.use('/api/jobs', verifyToken, createDispatchRouter(...))`
- `dispatch_log` schema prepared on startup.
- Scheduler enabled by env:
  - `SCHEDULER_ENABLED=true`
  - optional `DISPATCH_CRON` expression.

Environment behavior:
- If `BITRIX_REST_ENDPOINT` is not set, client works in mock mode.
- For real Bitrix REST calls, set `BITRIX_REST_ENDPOINT` to a valid portal REST endpoint URL.

Verification:

```bash
cd backends/node/api && node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js
docker exec azs-prod-api-node sh -lc 'node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js'
docker exec azs-prod-api-node node -e "<JWT smoke + POST /api/jobs/dispatch>"
```

Verification results:
- Unit tests: 10 passed, 0 failed (local and docker).
- Dispatch API smoke:
  - HTTP 200
  - summary includes correct counters for created/duplicates/failed.

Next sprint:
- Sprint 5 Admin Mobile Capture route and upload contract.
