# Project Log: АЗС прод

Project start: 2026-04-28 16:54:07 MSK (+0300)

Repository:
- Origin: https://github.com/TsygankovMain/azs-prod-starter.git
- Upstream: https://github.com/bitrix-tools/b24-ai-starter.git
- Upstream push: disabled

Bitrix24 work task:
- Project/group ID: 371
- Created by: 1
- Responsible: 11
- Task ID: 6475
- Status: created through direct Bitrix24 MCP
- Constraint: use only direct Bitrix24 MCP/REST access for Bitrix24 operations.

## Log Entries

### 2026-04-28 16:54:07 MSK

What happened:
- Project work started.
- Product goal fixed: Bitrix24 app for daily gas station photo reports.
- Stack fixed: Node.js backend and Nuxt frontend from `b24-ai-starter`.

Product impact:
- The project now has a clear implementation direction and sprint structure.

What to check:
- Confirm Bitrix24 MCP authorization is renewed before creating the project task.

Next step:
- Complete Sprint 0 control plane, then run Node + Nuxt bootstrap.

Commit/task:
- Commit: pending.
- Bitrix24 task: pending MCP reauthorization.

### 2026-04-28 17:04 MSK

What happened:
- Local `origin` confirmed as `https://github.com/TsygankovMain/azs-prod-starter.git`.
- `upstream` added for the original starter repository.
- `upstream` push URL disabled to prevent accidental pushes to the original repository.
- Direct Bitrix24 MCP credentials were found in Keychain.
- MCP task creation was not completed because token refresh fails with `invalid_client`.

Product impact:
- Future commits and pushes are directed to the user's repository.
- Original starter remains available only as a read reference.

What to check:
- Open Bitrix24 task 6475 in project 371 and verify time tracking is available.

Next step:
- Commit Sprint 0 logs and continue with Node + Nuxt bootstrap.

Commit/task:
- Commit: pending.
- Bitrix24 task: 6475.

### 2026-04-28 17:10 MSK

What happened:
- Removed all project references to the disallowed integration channel from the repository.
- Verified the working tree has no matching references.
- Created Bitrix24 project task 6475 through direct Bitrix24 MCP.

Product impact:
- Project management and time tracking are now connected to the Bitrix24 project.
- The repository documentation now points agents only to direct Bitrix24 MCP/REST access.

What to check:
- Confirm task 6475 is visible in Bitrix24 project 371.

Next step:
- Continue Sprint 1: Node + Nuxt bootstrap.

Commit/task:
- Cleanup commit: 9553fd8.
- Bitrix24 task: 6475.

### 2026-04-28 17:33 MSK

What happened:
- Sprint 1 bootstrap started and verified.
- Local `.env` was configured for Node backend, PostgreSQL, Cloudpub, and Bitrix24 app credentials.
- Docker containers were renamed to `azs-prod-*` to avoid conflicts with other local projects.
- Node + Nuxt stack was started in detached Docker Compose mode.
- Public Cloudpub URL is active: https://simply-staid-mollusk.cloudpub.ru

Product impact:
- The starter app is reachable through HTTPS and ready to be registered as a Bitrix24 local application.
- Development can continue on the Node + Nuxt stack without touching PHP/Python backends.

What to check:
- Open https://simply-staid-mollusk.cloudpub.ru/install.
- In Bitrix24 local app settings, use main URL `https://simply-staid-mollusk.cloudpub.ru/` and install URL `https://simply-staid-mollusk.cloudpub.ru/install`.

Next step:
- Continue Sprint 2: settings and smart-process mapping.

Commit/task:
- Bitrix24 task: 6475.

### 2026-04-28 17:49 MSK

What happened:
- Sprint 2 settings and smart-process mapping foundation was implemented.
- Added protected backend endpoint `/api/settings` with JSON file storage for development.
- Added validation and default settings for AZS smart process, Report smart process, stages, Disk root folder, timeout, jitter, and timezone.
- Added Nuxt route `/settings` for administrator mapping of entity type IDs, field codes, stage IDs, Disk settings, timeout, and dispatch jitter.
- Added backend tests for settings merge and validation.

Product impact:
- The app now has the first product configuration screen needed before Disk, dispatch, and report workflows can be implemented.
- PM/checker can see which Bitrix24 smart-process IDs and fields must be mapped for the photo-report lifecycle.

What to check:
- Open `https://simply-staid-mollusk.cloudpub.ru/settings` from the Bitrix24 app context.
- Verify `/api/settings` requires JWT and returns defaults after authorization.
- Confirm saved settings are local development data only and are not committed.

Next step:
- Continue Sprint 3: Disk module and folder/file naming rules.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-28 22:29 MSK

What happened:
- Sprint 3 Disk module foundation was implemented on Node backend.
- Added `ensureRootFolder`, `ensureFolderPath`, and `uploadPhoto` service functions.
- Added deterministic folder path builder and file name builder with safe-segment normalization.
- Added unit tests for folder path format, file name format, folder reuse behavior, and upload flow.

Product impact:
- The backend now has a reusable disk abstraction required for report-photo delivery.
- Next sprints can call the same service from report dispatch and mobile upload routes.

What to check:
- Backend tests include the new disk module and should pass in local and Docker environments.
- Verify naming format remains aligned with product rule: `{slotHHmm}_{photoCode}_{isoTimestamp}.{ext}`.

Next step:
- Continue Sprint 4: report dispatch scheduler and idempotent dispatch log.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-28 22:40 MSK

What happened:
- Sprint 4 backend foundation was implemented for scheduled report dispatch.
- Added `/api/jobs/dispatch` endpoint with JWT protection.
- Added `dispatch_log` table support for PostgreSQL and MySQL with unique key `(slot_key, azs_id)` for idempotency.
- Added jitter calculation `[-X, +X]` minutes and timeout-based deadline calculation.
- Added Bitrix REST client abstraction for `crm.item.add` and `im.notify.personal.add`.
- Added scheduler module based on `node-cron` (enabled only when `SCHEDULER_ENABLED=true`).
- Added candidate loader from local JSON file for automatic scheduler runs.

Product impact:
- Backend can now prevent duplicate dispatches per slot/AZS, create report records, and send notifications in one flow.
- This is API-level functionality; custom product UI is still in progress and separate from starter demo page.

What to check:
- `POST /api/jobs/dispatch` with candidates should return created/duplicates/failed summary.
- `dispatch_log` should be created automatically on API start.
- With valid report settings (`report.entityTypeId`), one candidate creates one report and one notify action.

Next step:
- Continue Sprint 5: admin mobile capture UI and photo upload flow integration.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-28 22:48 MSK

What happened:
- Implemented visible user-facing screens based on Bitrix24 UI Kit.
- Replaced demo home page with app navigation hub (`/`) to business screens.
- Added reviewer dashboard screen (`/reviewer`) with filters, report table, and manual dispatch action.
- Added admin mobile capture screen (`/admin/[reportId]`) for photo slot workflow UX.
- Added backend report APIs:
  - `GET /api/reports`
  - `GET /api/reports/:id`
  - `POST /api/reports/manual`

Product impact:
- The app now contains explicit product screens instead of only starter demo buttons.
- PM and users can open working interfaces and validate flow step-by-step.

What to check:
- Open `/` and verify cards for Settings, Reviewer, Admin screens.
- Open `/reviewer` and run manual report creation.
- Open `/admin/:reportId` from reviewer table and verify mobile photo slot UI.

Next step:
- Continue Sprint 6: actual photo upload endpoint and DONE transition logic.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-28 23:00 MSK

What happened:
- Implemented Sprint 6 backend upload flow `POST /api/reports/:id/photo`.
- Added `multer` memory upload with size limit 10 MB.
- Added EXIF check: if EXIF date exists and photo age exceeds configured limit, upload is rejected.
- Added Disk upload integration via `diskService` and `bitrixRestClient.diskApi`.
- Added persistence table `report_photo` and report-photo upsert/list operations.
- Added report status transition:
  - `in_progress` when part of required photos uploaded
  - `done` when all required photo codes are uploaded
- Updated admin mobile page to send real uploads, show per-slot upload state, and refresh report state after upload.

Product impact:
- Photo capture flow is no longer stub UI; it now sends files to backend and drives report lifecycle.
- Reviewer can now see status progression caused by actual photo uploads.

What to check:
- Manual dispatch -> open `/admin/:reportId` -> upload 4 required photos.
- Confirm API response transitions to `done` on last required photo.
- Confirm `/api/reports/:id` returns `photos[]` and status `done`.

Next step:
- Continue Sprint 7 timeout watcher and EXPIRED transition.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-28 23:06 MSK

What happened:
- Implemented Sprint 7 timeout watcher for overdue reports.
- Added `POST /api/jobs/timeout` to run expiration pass manually.
- Added automatic timeout scheduler run support inside job scheduler.
- Added overdue query in reports store (`deadlineAt < now` and status not DONE/EXPIRED).
- Added automatic transition to `expired` and optional reviewer notification.
- Added reviewer dashboard action button "Проверить просрочки".

Product impact:
- Overdue reports no longer stay in active states indefinitely.
- Reviewer can force timeout processing on demand from UI.

What to check:
- Create a report with past deadline, call `/api/jobs/timeout`, verify report status becomes `expired`.
- Verify summary counters: `total`, `expired`, `failed`, `notified`, `skipped`.
- With `SCHEDULER_ENABLED=true`, verify periodic timeout processing is running.

Next step:
- Continue Sprint 8: finalize reviewer dashboard UX and status analytics.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 09:22:22 MSK

What happened:
- Implemented Sprint 8 reviewer dashboard analytics improvements.
- Added backend endpoint `GET /api/reports/summary` with filters by date range and AZS id.
- Added aggregated counters in reports store: `total`, `open`, `done`, `expired`, `failed`, `overdue`, and `byStatus`.
- Updated reviewer screen with KPI cards and quick status filter buttons.
- Added frontend API method `getReportsSummary` and parallel loading of list + summary.
- Verified changed scope with backend tests and frontend eslint checks.

Product impact:
- Reviewer now sees operational status snapshot immediately on one screen.
- Filtering and decision-making are faster due to quick status toggles and overdue visibility.

What to check:
- Open `/reviewer` and verify KPI cards update with date/AZS filters.
- Test quick filters (`new`, `in_progress`, `done`, `expired`, `failed`) and table refresh.
- Check `/api/reports/summary` returns expected structure for current data.

Next step:
- Continue Sprint 9: manual trigger UX hardening and idempotency checks against auto slots.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 09:25:16 MSK

What happened:
- Implemented Sprint 9 manual trigger hardening.
- Added separated reserve key strategy for manual dispatch:
  - `manual:${slotKey}` is used only for idempotency reservation.
  - Auto dispatch keeps base `slotKey` format.
- Kept report lifecycle unchanged for manual flow (`dispatch -> report create -> notify`).
- Added reviewer UI feedback for duplicate manual slots in success message.
- Added regression test that manual dispatch does not block auto dispatch for the same AZS and time slot.

Product impact:
- Manual launch no longer blocks scheduled auto slots for the same AZS/time.
- Reviewer gets clearer feedback when a manual slot was already created.

What to check:
- In `/reviewer`, run manual creation twice with same AZS/date/time:
  - first should create
  - second should return duplicate in message
- Verify later auto dispatch for the same slot still creates its own report.

Next step:
- Continue Sprint 10: QA pass, release checklist, and production runbook.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 09:29:40 MSK

What happened:
- Reworked admin photo capture UX to camera-only flow.
- Removed file picker (`input type=file`) from admin report screen.
- Added direct camera stream (`getUserMedia`) with capture button and immediate upload.
- Added camera lifecycle handling (open/close/cleanup on page unmount).

Product impact:
- In-app flow no longer proposes gallery/file selection UI from the app layer.
- Admin now captures fresh photos directly from camera preview for each required slot.

What to check:
- Open `/admin/:reportId` in mobile Bitrix24.
- For each slot click "Открыть камеру" -> "Сделать фото".
- Verify upload status and DONE transition after all required photos.

Next step:
- Continue Sprint 10 QA pass on real mobile devices and WebView permission matrix.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 09:46:06 MSK

What happened:
- Fixed mobile camera runtime error: `cameraVideoEl.value.play is not a function`.
- Replaced repeated template ref binding with explicit ref setter for native `<video>`.
- Added safe video playback guard before calling `play()`.

Product impact:
- Camera open flow works correctly on mobile WebView where prior ref binding returned non-video value.

What to check:
- Open admin screen on phone and press "Открыть камеру".
- Ensure camera preview appears without red error alert.

Next step:
- Continue mobile QA for camera permissions on Android/iOS Bitrix24 WebView.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.
