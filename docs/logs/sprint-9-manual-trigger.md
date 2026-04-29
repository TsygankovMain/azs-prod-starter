# Sprint 9: Manual Trigger

## PM Summary

Goal:
- Ensure manual report launch does not conflict with scheduled auto slots.

Done:
- Implemented isolated idempotency key for manual dispatch reservations:
  - manual reserve key: `manual:${slotKey}`
  - auto reserve key: unchanged `slotKey`
- Kept same business lifecycle as auto dispatch:
  - create report
  - notify admin
  - persist dispatch state
- Improved reviewer success message with duplicate slot list for manual runs.

Business result:
- Manual launch no longer blocks the scheduler's auto slot for same AZS/time.
- Reviewer sees transparent feedback when duplicate manual run is attempted.

## Agent Notes

Backend changes:
- `backends/node/api/src/dispatch/dispatchService.js`
- `backends/node/api/tests/dispatchService.test.js`

Frontend changes:
- `frontend/app/pages/reviewer.client.vue`

Verification:

```bash
docker exec azs-prod-api-node sh -lc 'cd /app && node --test tests/dispatchService.test.js tests/timeoutWatcher.test.js tests/settings.test.js tests/diskService.test.js'
docker exec azs-prod-frontend sh -lc 'cd /app && pnpm exec eslint app/pages/reviewer.client.vue'
```

Verification results:
- Backend tests pass (`13/13`), including:
  - duplicate prevention for same trigger/slot
  - manual trigger does not block auto trigger
- Frontend lint passes for changed file.

Next sprint:
- Sprint 10 QA and release:
  - end-to-end acceptance flow
  - production `.env` checklist
  - release notes and runbook
