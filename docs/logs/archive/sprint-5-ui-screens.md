# Sprint 5: User Screens On Bitrix24 UI Kit

## PM Summary

Goal:
- Replace starter demo UI with real product screens and make Bitrix24 UI Kit visible in application flows.

Done:
- Home page `/` now acts as product navigation hub.
- Added screen `/reviewer`:
  - filters by date/status/AZS
  - report table with status badges
  - manual dispatch button ("Создать сейчас")
- Added screen `/admin/[reportId]`:
  - report summary block
  - mobile-oriented photo slot UI (camera/file picker)
  - progress badge by required positions
- Added backend APIs required by screens:
  - `GET /api/reports`
  - `GET /api/reports/:id`
  - `POST /api/reports/manual`

Business result:
- The application now has explicit user-facing interfaces beyond starter template.
- Reviewer and admin flows can be shown and tested in Bitrix24 iframe.

Scope note:
- This sprint focused on UI and read/write flow orchestration.
- Actual binary upload to Bitrix24 Disk and automatic DONE transition remains in Sprint 6.

## Agent Notes

Frontend files:
- `frontend/app/pages/index.client.vue`
- `frontend/app/pages/reviewer.client.vue`
- `frontend/app/pages/admin/[reportId].client.vue`
- `frontend/app/stores/api.ts` (new report API methods)

Backend files:
- `backends/node/api/src/reports/reportsStore.js`
- `backends/node/api/src/reports/reportsRoutes.js`
- `backends/node/api/server.js` (mount `/api/reports`)

Verification:

```bash
node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js
docker exec azs-prod-api-node sh -lc 'node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js'
docker exec azs-prod-frontend sh -lc 'pnpm exec eslint app/pages/index.client.vue app/pages/reviewer.client.vue app/pages/admin/[reportId].client.vue app/stores/api.ts'
docker exec azs-prod-frontend sh -lc 'pnpm build'
docker exec azs-prod-api-node node -e "<smoke GET/POST /api/reports>"
```

Verification results:
- Backend tests: passed.
- Targeted ESLint for new UI files: passed.
- Frontend production build: passed.
- API smoke:
  - `GET /api/reports` returns 200.
  - `POST /api/reports/manual` returns 200 and duplicate protection works on repeated call.

Next sprint:
- Implement `POST /api/reports/:id/photo` with file validation and Disk upload integration.
