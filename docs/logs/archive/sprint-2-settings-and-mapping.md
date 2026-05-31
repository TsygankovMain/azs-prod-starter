# Sprint 2: Settings And Mapping

## PM Summary

Goal:
- Give the app administrator a screen to configure Bitrix24 smart-process mapping before business automation starts.

Done:
- Added `/settings` route in the Nuxt frontend.
- Added protected backend route `/api/settings`.
- Added mapping fields for AZS smart process, Report smart process, Report stages, Disk root folder, timeout, jitter, and timezone.
- Added default configuration values so the screen opens even before the portal is fully mapped.
- Added validation for required object structure and numeric ranges.
- Added tests for settings merge and invalid timeout/jitter values.

Business result:
- The project now has a configuration foundation for later sprints.
- Disk upload, report dispatch, mobile photo capture, timeout processing, and reviewer dashboard can reuse the same settings contract.

Current limitation:
- Settings are stored in a local ignored JSON file during development.
- Direct Bitrix24 `app.option.get/set` storage is intentionally deferred until install-token persistence is implemented.

## Agent Notes

Backend:
- `GET /api/settings` returns `{ settings, defaults }`.
- `PUT /api/settings` accepts `{ "settings": { ... } }`.
- Route is mounted behind `verifyToken`, so requests without JWT return `401`.
- Local development storage path is `backends/node/api/data/settings.json`.
- The data path is ignored by Git.

Settings contract:
- `azs.entityTypeId`
- `azs.fields.admin`
- `azs.fields.reviewers`
- `azs.fields.photoSet`
- `azs.fields.schedule`
- `azs.fields.timezone`
- `azs.fields.enabled`
- `report.entityTypeId`
- `report.fields.azs`
- `report.fields.admin`
- `report.fields.slotTime`
- `report.fields.scheduledAt`
- `report.fields.deadlineAt`
- `report.fields.trigger`
- `report.fields.folderId`
- `report.fields.photos`
- `report.fields.photoStatus`
- `report.stages.new`
- `report.stages.inProgress`
- `report.stages.done`
- `report.stages.expired`
- `report.timeoutMinutes`
- `report.dispatchJitterMinutes`
- `disk.rootFolderId`
- `disk.folderNameTemplate`
- `timezone`

Frontend:
- `/settings` loads settings through `useApiStore().getSettings()`.
- Save uses `useApiStore().saveSettings(settings)`.
- The page shows dirty state, loading state, save errors, and a non-admin warning.
- The page is designed as a dense working interface, not a landing page.

Verification:

```bash
cd backends/node/api && node --test tests/settings.test.js
docker exec azs-prod-api-node sh -lc 'node --test tests/settings.test.js'
docker exec azs-prod-frontend sh -lc 'pnpm exec eslint app/pages/settings.client.vue app/stores/api.ts'
docker exec azs-prod-frontend sh -lc 'pnpm build'
curl -i -sS http://localhost:8000/api/settings
curl -i -sS https://simply-staid-mollusk.cloudpub.ru/settings
```

Verification results:
- Backend settings tests passed.
- Targeted ESLint for changed frontend files passed.
- Frontend build passed.
- `/api/settings` returns `401` without JWT, as expected.
- Public `/settings` route returns HTTP 200.

Known project issue:
- Full frontend lint still reports pre-existing starter violations in unrelated files. Sprint 2 changed files pass targeted lint.

Next sprint:
- Implement Sprint 3 Disk module: `ensureFolderPath`, `ensureRootFolder`, `uploadPhoto`, safe folder/file names, and tests.
