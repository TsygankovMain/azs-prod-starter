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

### 2026-04-30 19:09:56 MSK

What happened:
- Investigated why auto report did not trigger at expected time.
- Confirmed runtime root causes from container/logs:
  - `dispatchScheduler` had been disabled in runtime earlier.
  - saved slot in settings was `19:00` (not `18:45`) at time of check.
  - auto candidate builder risk: AZS item id may come as `ID` (uppercase), previous code primarily used `id`.
- Applied runtime stability fixes:
  - ensured scheduler startup path is active and verified by logs (`dispatchScheduler: started`).
  - updated backend install flow to refresh REST auth token in runtime:
    - `/api/install` now updates `BITRIX_REST_AUTH_ID` in process
    - `bitrixRestClient.setAuthId(...)` added and used
  - fixed scheduler AZS candidate extraction for both `id` and `ID`.

Product impact:
- Auto slot processing no longer silently loses AZS candidates because of `ID` casing.
- Backend can continue using fresh auth token after install/reinstall without container rebuild.

What to check:
- In `/settings`, set a future slot time and save.
- Verify log line every minute: `dispatchScheduler: run finished ...`
- At slot minute verify `created > 0` (not only `total: 0`).

Next step:
- Optional: add diagnostics endpoint with current scheduler mode, next slot, and resolved candidates count.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-30 18:51:32 MSK

What happened:
- Implemented automatic report dispatch by time slots from app settings.
- Added `report.dispatchTimes` (array of `HH:mm`) to backend settings contract.
- Dispatch scheduler now:
  - reads `timezone` + `report.dispatchTimes` from `/api/settings`
  - runs auto-dispatch only when current portal time matches one of configured slots
  - stamps candidates with `slotDate` + `slotHHmm` for that slot
  - prevents duplicate processing of the same minute slot within process runtime
- Added fallback auto-candidate source from AZS smart-process:
  - when file candidates are empty, backend reads AZS items via `crm.item.list`
  - uses mapped fields `azs.fields.admin` and optional `azs.fields.enabled`
- Extended Bitrix REST client with `listCrmItems` pagination helper (`crm.item.list`, `useOriginalUfNames=Y`).
- Updated UX to avoid manual numeric time/date typing:
  - Reviewer manual launch now uses calendar (`type=date`) and clock (`type=time`) pickers.
  - Settings page now uses multiple time pickers for `dispatchTimes` (add/remove slots), no raw HHmm input.

Product impact:
- PM/admin can configure automatic bot-trigger times in settings without editing JSON or typing HHmm manually.
- Manual launch is now calendar/clock based and less error-prone.

What to check:
- In `/settings` add time slot `18:45`, save settings.
- Ensure `SCHEDULER_ENABLED=true` and scheduler is running.
- At 18:45 portal timezone, bot should auto-send report request to AZS admin.

Next step:
- Optional: add explicit backend endpoint to preview "next scheduled run" for easier operational monitoring.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 21:07:30 MSK

What happened:
- Rechecked bot registration path and confirmed root cause:
  - `/api/install` previously did not register bot at all (stub response only).
  - Current REST auth token from `.env` returns `expired_token` for `imbot.*` checks.
  - Local `.env` scopes were outdated and did not include `imbot`/`im`/`disk`/`user`.
- Implemented bot auto-registration on install:
  - added `botRegistryService` with `imbot.v2.Bot.register` and `imbot.v2.Bot.list`
  - `/api/install` now, in `BITRIX_BOT_MODE=bot`, uses install payload `AUTH_ID` to register bot
  - backend updates runtime `BITRIX_BOT_ID` from registration result and reuses it in notifications
- Extended Bitrix REST client with `callMethodWithAuth` for install-time OAuth token usage.
- Updated local env and docs with bot variables:
  - `BITRIX_BOT_MODE`, `BITRIX_BOT_ID`, `BITRIX_BOT_CODE`, `BITRIX_BOT_NAME`
- Added backend tests for bot registry service.

Product impact:
- Bot registration now happens automatically during app install/reinstall, not manually outside app code.
- Notification channel `bot` can start working immediately after successful install and scope renewal.

What to check:
- Reinstall app in portal (to refresh OAuth token and scopes).
- Ensure app scopes include: `crm,disk,im,imbot,user,user_brief,pull,placement,userfieldconfig`.
- Open `/install` flow and verify `/api/install` returns `bot.registered=true` and `bot.botId > 0`.
- Run manual dispatch and verify messages come from bot “Порядок на АЗС”.

Next step:
- Optional: persist registered `botId` to durable storage (settings/app.option) to keep value after container restart.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 17:04:28 MSK

What happened:
- Implemented production notification layer with bot-first strategy:
  - added `NotificationService` (`bot` via `imbot.v2.Chat.Message.send`, fallback to `im.notify.personal.add`)
  - added REST_APP_URI report links in messages (`/marketplace/view/{APP_CODE}/?...`)
- Integrated `NotificationService` into:
  - dispatch flow (new report notification to AZS admin)
  - timeout watcher (expired report notification to reviewer)
  - upload completion flow (DONE notification to reviewer)
- Hardened report CRM sync:
  - strict mode for missing/invalid `reportItemId` during upload sync
  - explicit runtime verification that report `folderId` field in CRM is actually updated
  - clear sync error when `folderId` mapping is missing or not written
- Added production validation rule:
  - `report.fields.folderId` is required when `BITRIX_REST_ENDPOINT` is configured
- Added frontend deep-link handling:
  - index page now resolves `reportId` from query/REST_APP_URI placement params and opens `/admin/{reportId}`
- Updated env and docs:
  - added `BITRIX_BOT_MODE`, `BITRIX_BOT_ID`, `BITRIX_APP_CODE`, `APP_PUBLIC_BASE_URL`
  - expanded required scopes with `disk`, `im`, `imbot`, `user`
  - added portal setup spec for Bitrix24 specialist: `docs/bitrix24-portal-setup.md`

Product impact:
- Notifications can now be sent from named bot scenario ("Порядок на АЗС"), with automatic fallback.
- Report links in notifications open the app report screen via Bitrix24 app-link mechanism.
- Folder ID persistence into CRM report card is now controlled and diagnosable in runtime.

What to check:
- Configure env for bot mode and reinstall app with updated scopes.
- Run manual dispatch and verify bot message contains `/marketplace/view/{APP_CODE}/...` link.
- Upload first photo and verify CRM report string field "Папка Диска" gets folder id.
- Open app via REST_APP_URI link and confirm redirect to `/admin/{reportId}`.

Next step:
- Bind and verify actual bot registration on portal, then run full portal smoke test in mobile/web.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 16:38:32 MSK

What happened:
- Added production env contract for Bitrix REST:
  - `BITRIX_REST_ENDPOINT`
  - `BITRIX_REST_AUTH_ID`
- Updated Node Bitrix REST client to include `auth` token in every REST call payload.
- Improved REST HTTP error diagnostics by returning Bitrix response body in backend error text.
- Applied local `.env` with live portal endpoint and auth token for runtime test.
- Recreated Docker stack (`frontend`, `api-node`, `cloudpub`, `db-postgres`) to apply new env.

Smoke test result:
- `crm.item.get` live call works from backend container for AZS entity/item (`entityTypeId=1114`, `id=2`).
- `GET /api/reports/11` returns real required photo list from portal smart-process fields (no template fallback).
- `POST /api/reports/12/photo` upload works and returns `status=in_progress` with real file/folder IDs.
- Manual dispatch currently fails on notification step with Bitrix error:
  - `insufficient_scope` for `im.notify.personal.add`.
  - This is a token scope/permission issue, separate from report data flow.

Product impact:
- Report data flow now runs against live portal data with production env.
- Required photo set is confirmed real in runtime and upload path works.
- Remaining blocker is notification scope, not demo fallback.

What to check:
- In Bitrix24 app settings, ensure token/scope includes notification rights used by `im.notify.personal.add`.
- Re-run manual dispatch after scope fix and verify `summary.created=1` instead of `failed=1`.

Next step:
- Either extend token scope for `im.notify.personal.add` or degrade notification failure to non-blocking warning.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 16:25:57 MSK

What happened:
- Switched report flow to production-only mode (no mock, no template fallback).
- Removed Bitrix REST mock behavior in Node client:
  - no fake responses when endpoint is missing
  - explicit runtime error if `BITRIX_REST_ENDPOINT` is not set
  - no fake `reportItemId` generation
- Removed template required-photo fallback from report API:
  - deleted default photo set usage
  - strict validation of AZS/photoType mapping and AZS item id
  - if mapping/data is invalid, backend now returns explicit `422` error codes.
- Admin screen no longer injects default demo photo slots.
- Admin screen now shows backend config/data errors directly for report load.

Product impact:
- Report behavior is deterministic and based only on real portal data.
- Misconfiguration now fails loudly with actionable errors instead of silent demo substitution.
- Demo slots (`totem/columns/shop/territory`) are no longer shown by default.

What to check:
- Ensure backend env has `BITRIX_REST_ENDPOINT` configured for your portal.
- Open `/admin/:reportId` for a report with valid numeric AZS item id and mapped photo set.
- Verify required photo list is taken only from AZS + PhotoType entities.

Next step:
- Set `BITRIX_REST_ENDPOINT` and run a full portal smoke test (manual dispatch -> admin upload -> DONE/EXPIRED).

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 16:01:50 MSK

What happened:
- Investigated mobile upload error `Current user is not report administrator`.
- Confirmed report `#1` is assigned to `admin_user_id=11`, while current Bitrix24 user/JWT is `user_id=1`.
- Improved reviewer manual trigger defaults:
  - removed hardcoded admin user `11`
  - manual report form now defaults to current Bitrix24 user ID after app initialization
- Improved forbidden upload error details:
  - backend returns `currentUserId`
  - backend returns `expectedAdminUserId`
  - admin screen displays both IDs for faster test diagnostics

Product impact:
- New manual reports created by the current tester are uploadable by that tester by default.
- Existing reports still respect the security rule: only the assigned station administrator can upload photos.
- Permission errors now explain who is current user and who is assigned to the report.

What to check:
- Open `/reviewer`, create a new manual report without changing "Админ user id".
- Open the new report admin screen and upload a photo.
- Do not reuse old report `#1` unless testing as user `11` or changing its admin assignment.

Next step:
- Retest upload on a newly created report assigned to current user `1`.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 15:51:45 MSK

What happened:
- Fixed mobile photo upload `400 Bad Request`.
- Root cause found in API logs: multipart camera upload was sent with global `Content-Type: application/json`, so Express JSON parser tried to parse `------WebKit...` as JSON before `multer`.
- Removed global JSON header from Nuxt API store.
- Changed JSON requests to send object bodies so `$fetch` sets JSON headers only for JSON requests.
- Kept photo upload as `FormData` with only Authorization header.
- Improved admin screen error display to show backend `message/error` when available.

Product impact:
- Camera photo upload can reach backend `multer` as multipart instead of being rejected before route handling.
- Future upload errors should be readable on the phone, not only `400 Bad Request`.

What to check:
- Reopen `/admin/1` in Bitrix24 mobile WebView.
- Open camera, take a photo, press upload.
- If a new error appears, it should now show the actual backend reason.

Next step:
- Retest mobile upload on the same report and verify Disk upload plus report status transition.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 15:43:29 MSK

What happened:
- Hardened Sprint 6/7 lifecycle synchronization with Bitrix24 smart-process reports.
- Added `crm.item.update` support to the Node Bitrix REST client.
- Added shared report CRM sync helper for update payloads.
- Photo upload now:
  - validates `photoCode` against the AZS required photo set before Disk upload
  - updates local report status to `in_progress` or `done`
  - updates the Bitrix24 report item stage using mapped stages
  - writes mapped Disk folder field as string
  - writes mapped photos field with uploaded file IDs
- Timeout watcher now updates the Bitrix24 report item to mapped `EXPIRED` stage when `reportItemId` exists.
- Added unit tests for CRM update payload and timeout CRM stage sync.

Product impact:
- Reviewer sees lifecycle changes not only in the app dashboard, but also in the Bitrix24 report smart-process card.
- Invalid photo codes no longer create unnecessary files on Bitrix24 Disk.
- DONE/EXPIRED workflow is closer to real portal acceptance testing.

What to check:
- Upload photos in `/admin/:reportId` and verify the Report SP card changes stage to in-progress/DONE.
- Verify the Report SP folder field contains a Disk folder ID string.
- Verify the Report SP photos field receives uploaded file IDs.
- Create an overdue report and run `/api/jobs/timeout`; verify the Report SP card moves to EXPIRED.

Next step:
- Restart local API container if needed and run a portal smoke test through Bitrix24 WebView.

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

### 2026-04-29 12:08:50 MSK

What happened:
- Reworked `/settings` field mapping UX from manual code input to portal metadata driven mapping.
- Added dropdowns with all smart processes from `crm.type.list` for:
  - AZS
  - Photo Types
  - Report
- Added field mapping tables that load fields from selected smart process via `crm.item.fields`.
- Added "Create" action for missing fields through `userfieldconfig.add`.
- Removed AZS schedule/timezone field mapping from settings UI; these are global app settings now.
- Added `photoType` settings block for the smart-process photo dictionary.
- Updated report creation to use standard CRM fields where possible:
  - `title`
  - `assignedById`
  - `begindate`
  - `closedate`
  - `opened`

Product impact:
- Portal administrator no longer needs to copy UF field codes manually.
- Settings screen now supports the target Bitrix24 specialist workflow: select smart process, select field, create missing field.
- Report cards become closer to native Bitrix24 behavior by relying on standard fields.

What to check:
- Open `/settings` inside Bitrix24.
- Verify smart-process dropdowns are populated.
- Select AZS/Photo Types/Report smart processes and verify field dropdowns load.
- Try "Create" for a simple missing field and confirm it appears after reload.

Next step:
- Add runtime use of AZS `photoSet` and Photo Types dictionary for dynamic required photo slots.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 12:32:11 MSK

What happened:
- Simplified report mapping according to product constraints.
- Removed report field mappings that are not used in business flow:
  - slot time
  - photo status
- Changed report Disk folder field creation type from number to string.
- Added automatic report stage loading:
  - read `stageId.statusType` from `crm.item.fields`
  - load stages through `crm.status.entity.items`
  - show stages as dropdowns in settings.

Product impact:
- Report settings are smaller and closer to the real app workflow.
- Portal admin can select stages from actual Bitrix24 stages instead of copying IDs manually.

What to check:
- Open `/settings`, select Report smart process, verify stage dropdowns are populated.
- Confirm report mapping table no longer contains "Слот отчёта" and "Статус фото".
- Use "Создать" for "Папка Диска" and verify created field is string/text, not number.

Next step:
- Implement dynamic required photo slots from AZS `photoSet` and Photo Types smart process.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 12:47:34 MSK

What happened:
- Fixed required photo source for admin capture screen and DONE calculation.
- Added runtime loading of required photos from AZS smart-process item:
  - read AZS item by `settings.azs.entityTypeId` and report `azsId`
  - read AZS `photoSet` mapped field
  - load selected Photo Type items by `settings.photoType.entityTypeId`
  - use mapped Photo Type fields: `code`, `title`, `sort`, `active`
- `GET /api/reports/:id` now returns `requiredPhotos`.
- Admin mobile screen now renders slots from `requiredPhotos` instead of fixed hardcoded list.
- Photo upload now rejects photo codes that are not required for the report's AZS.

Product impact:
- Different AZS cards can have different required photo sets.
- The admin screen now follows the photo set configured in the AZS card.
- DONE status now depends on the AZS-specific required set, not global defaults.

What to check:
- In `/settings`, confirm AZS `photoSet` and Photo Types mapping are saved.
- Create/open report where `azsId` is the CRM item ID of the AZS card.
- Open `/admin/:reportId` and verify the displayed photo slots match the AZS `photoSet`.

Next step:
- If existing reports were created with non-numeric `azsId`, recreate them with the actual AZS item ID for reliable CRM lookup.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.

### 2026-04-29 15:33:50 MSK

What happened:
- Removed starter demo surfaces from the application code.
- Deleted demo frontend pages:
  - telemetry test
  - demo CRM deal placement handler
  - demo user-field handler
  - demo background error handler
  - demo app-options slider
- Removed demo backend endpoints:
  - `GET /api/enum`
  - `GET /api/list`
- Removed demo API store methods and demo install registrations for CRM placement/user-field type.
- Updated README API examples to use real app methods instead of demo list/enum methods.

Product impact:
- The app no longer exposes starter demo buttons, demo routes, or demo REST endpoints.
- Installation flow no longer registers unrelated demo Bitrix24 placements/user-field types.
- The visible product surface is focused on AZS photo reports.

What to check:
- Reinstall/open the app in Bitrix24 and verify demo pages/buttons are gone.
- Open `/`, `/settings`, `/admin/:reportId`, `/reviewer` and verify product screens still load.
- Confirm old demo URLs like `/telemetry-test`, `/handler/uf.demo`, `/slider/app-options` are not part of the app anymore.

Next step:
- Continue Sprint 6/7 hardening around real Bitrix24 report creation, upload lifecycle, DONE/EXPIRED and portal acceptance testing.

Commit/task:
- Bitrix24 task: 6475.
- Commit: pending.
