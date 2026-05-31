# Sprint 6: Photo Upload And DONE

## PM Summary

Goal:
- Make admin photo uploads real, store uploaded files, and move report status to DONE after all required photos.

Done:
- Added endpoint:
  - `POST /api/reports/:id/photo`
- Added upload safeguards:
  - JWT-based user check (uploader must match report admin)
  - max file size `10 MB`
  - EXIF freshness validation when EXIF exists
- Added disk integration:
  - root folder resolve
  - path and file naming using existing Disk service
  - upload via Bitrix REST adapter (with mock fallback when endpoint not configured)
- Added DB persistence for photos:
  - `report_photo` table
  - upsert by `(report_id, photo_code)`
- Added status progression:
  - `in_progress` until required set is complete
  - `done` when required photo set is fully uploaded
- Updated admin UI:
  - file input now sends real request
  - slot-level upload/error states
  - success message when report becomes DONE

Business result:
- End-to-end photo flow is operational: report request -> photo uploads -> lifecycle transition.

## Agent Notes

Backend files changed:
- `backends/node/api/src/reports/reportsRoutes.js`
- `backends/node/api/src/reports/reportsStore.js`
- `backends/node/api/src/dispatch/bitrixRestClient.js`
- `backends/node/api/src/dispatch/dispatchLogStore.js`
- `backends/node/api/server.js`
- `backends/node/api/package.json`
- `backends/node/api/pnpm-lock.yaml`

Frontend files changed:
- `frontend/app/pages/admin/[reportId].client.vue`
- `frontend/app/stores/api.ts`

New dependencies:
- `multer`
- `exifr`

Verification:

```bash
cd backends/node/api && node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js
docker exec azs-prod-api-node sh -lc 'node --test tests/settings.test.js tests/diskService.test.js tests/dispatchService.test.js'
docker exec azs-prod-frontend sh -lc 'pnpm exec eslint app/pages/admin/[reportId].client.vue app/stores/api.ts app/pages/reviewer.client.vue app/pages/index.client.vue'
docker exec azs-prod-frontend sh -lc 'pnpm build'
docker exec azs-prod-api-node node -e "<manual report + 4x upload photo smoke>"
```

Verification results:
- Tests pass (`10/10`).
- Targeted ESLint passes for changed frontend files.
- Frontend production build passes.
- Smoke upload flow:
  - first uploads return `in_progress`
  - final required upload returns `done`
  - `GET /api/reports/:id` returns `photos[]` and final status `done`

Next sprint:
- Implement timeout watcher and automatic EXPIRED transition with notifications.
