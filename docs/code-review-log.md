# Code Review Log: АЗС прод

Append-style review log. New entries on top.

Format per entry:
- Date (MSK)
- Scope (what was reviewed)
- Findings (facts, file:line)
- Risks (production impact)
- Decision (action taken or scheduled)
- Verification

---

## 2026-05-31 — Sprints 2-5 (v2.0): frontend + deep-link flag + docs — IMPLEMENTED & REVIEWED

### Scope
Branch `feature/v2.0`. Sprints 2-5 from the design spec, executed with parallel Sonnet agents (disjoint file sets, controller-committed) + per-screen regression reviews.

### What shipped
| Sprint | Commit | Result |
|---|---|---|
| Docs | `201a2ac` | Consolidated `docs/`: README index, `CHANGELOG.md`, `RELEASES.md`, `architecture/overview.md` + `architecture/feature-map.md`; sprint logs archived to `docs/logs/archive/`; deleted stub `bitrix24-portal-setup.md`. |
| S5 | `fd2d57c` | Bot deep-link button behind `ENABLE_REPORT_DEEP_LINK` (default off) — `dispatchService` builds keyboard via `reportLinks`, `notificationService` threads it; flag-off byte-identical. index/install screens get B24 status-step panels + error alerts. +4 tests. |
| S2 | `5f185c4` | Admin `[reportId]` → mobile **focus-mode A1**: hero camera for active slot, sticky progress stepper, big touch buttons, auto-advance, "Все слоты" collapsible. Script/queue/camera logic untouched. |
| S3 | `5f185c4` | Reviewer: schedule UX hint ("задаётся один раз"); manual AZS **multi-select** ("Запросить у N АЗС", backend already took arrays); per-AZS filter + mini-KPI (client-side from existing reports); resync button → new `api.resyncReport`. |
| S4 | `5f185c4` | Settings: adaptive nav (desktop sidebar w/ completion ✓ / mobile B24Accordion); field "?" hints; per-section completion badges; sticky save; raw HTML → B24 components. Smart-process mapping logic preserved. |

### Regression reviews (per screen)
- **Settings (highest risk — select→B24Select):** ✅ verified every smart-process selector still triggers `loadFieldsForModule`/`loadReportStages` on change; all v-model paths and handlers intact. No regression.
- **Admin focus-mode:** ❌→✅ caught + fixed a **Critical** bug — `scrollToFirstProblemSlot` ("К проблемам" + auto-scroll on blocked submit) silently no-opped when the collapsed-by-default "Все слоты" list left its slot refs unmounted. Fixed: expand list + `nextTick` before scrolling. Restored the concurrency-mode badge ("бережный режим" on x1).
- **Reviewer:** all 4 changes verified; `manualRequest.azsId` fully migrated to `azsIds` (no dangling refs).

### Verification
- Backend suite **130/130 green** (Sprint 1's 126 + 4 deep-link tests).
- All 4 touched frontend files lint-clean (0 errors, 0 warnings after `--fix`).
- Frontend `typecheck` not run to completion — known `oxc-parser` native-binding issue in this environment (pre-existing, unrelated). **Follow-up:** run `nuxi typecheck` in a working CI/dev env before release.

### Known follow-ups
- syncStatus badge in the reviewer feed: the feed data doesn't yet carry per-report `syncStatus`; the resync button works, but the "не синхронизировано" badge needs the feed to surface sync state (TODO in code).
- Live device test of mobile admin camera/upload flow (can't verify in this env).
- Folder-template default alignment (former Sprint-1 T9) — dropped per user; revisit only if a reinstall reintroduces the old structure.

---

## 2026-05-31 — Sprint 1 (v2.0): durable CRM-sync queue — IMPLEMENTED & REVIEWED

### Scope
Branch `feature/v2.0` (from `master @ 2e60861`). Sprint 1 of the v2.0 plan (`docs/superpowers/plans/2026-05-31-azs-v2-sprint1-durable-crm-sync.md`): close the P0 in-memory CRM-sync loss identified in the prior review. Executed subagent-driven (fresh implementer + spec reviewer + code-quality reviewer per task).

### What shipped (commits on feature/v2.0)
| Task | Commits | Result |
|---|---|---|
| T1-2 | `0882cb8`, `db3d044` | `src/reports/crmSyncJobStore.js` — durable job table `crm_sync_jobs` (PG+MySQL), enqueue/claim/markDone/markFailed/reschedule. Fixed MySQL double-claim (affectedRows guard) + toDateSql NaN guard. |
| T3-4 | `28ddc67`, `2f170ba` | `src/reports/crmSyncWorker.js` — polling worker, backoff `[800,1600,3200]`+jitter, exhaust→failed. Fixed: separate sync-error vs persistence-error in tick(); log drain failures. |
| T5 | `96878ec` | `buildCrmSyncRunner` extracted — worker reuses the same `syncReportCrmStrict` path; resolves per-user context via `getContextByKey`. |
| T6 | `ed70458`, `88f0001` | `/photo` + `/submit` now enqueue a durable job instead of the in-memory queue; in-memory `createPerReportTaskQueue` + `runRetryableCrmSync` removed. **Also removed the admin-context 502 gate from the upload/submit request path** (deferred sync resolves context itself) — uploads no longer fail when the admin OAuth token is briefly unavailable. |
| T7 | `20da35b`, `1ff3638` | `POST /:id/resync` (reviewer-guarded) + `syncStatus {synced,lastSyncError,syncState}` on `GET /:id`. |
| T8 | `0612e07`, `d8cdbdd` | Boot wiring in `server.js`: construct store+worker, `ensureSchema`, start worker (gated `CRM_SYNC_WORKER_ENABLED`, default on); `.env.example` updated. |
| T9 | — | **DEFERRED** (folder-template default alignment) — blocked on confirming the exact production template string from portal settings; also needs `{yyyy-mm-dd}` token support in `diskService.js`. |

### Risk closed
- **P0 CRM-sync loss on restart (was high):** sync jobs now persist in `crm_sync_jobs` and resume after a crash/deploy. `synced=false` + `lastSyncError` are visible to reviewers; a manual "Пересинхронизировать" re-enqueue exists. No more silent orphaned smart-process items.
- **Secondary win:** removed an admin-token 502 gate from photo upload/submit — directly reduces the token-fragility class of failures.

### Final whole-feature review (Opus) — 2 issues found & fixed
A final integration review across the whole sprint (commit `c463efc`) caught what per-task reviews missed:
- **C1 (critical):** orphaned `running` jobs were permanent. A crash mid-sync left a row `running`; `claimNextDue` excludes any report with a `running` job, so that report would NEVER sync again — and even manual resync couldn't rescue it. This re-introduced the exact durable-stuck failure the sprint targeted (strictly worse than the old in-memory loss, which self-cleared). **Fix:** `crmSyncJobStore.reclaimStale()` (both drivers, optional `runningTimeoutMs`) + `crmSyncWorker.recover()` called at boot before polling resets orphaned `running`→`pending`. 7 dedicated tests.
- **I2 (important):** Task 6's dead-code removal accidentally made the sync run under the **uploader's** token instead of admin — but report-SPA CRM writes require admin scope (regular AZS-user tokens hit `insufficient_scope`, per the strict-admin design in `authContextStore.getLastAdminContext`). **Fix:** `buildCrmSyncRunner` now resolves admin context via `getLastAdminContext()`, falling back to the uploader's `contextKey` only if no admin context exists.
- **#7 worker-before-schema:** reviewed, NOT a problem — `drain().catch` logs and self-heals once `ensureSchema` finishes.

### Pre-existing 4 failures — root-caused & fixed (commit `91c3ce7`)
The 4 long-standing failures (present at baseline `fcd336f`) were triaged and fixed:
- **`authContextStore.upsertContext` (real bug):** normalized input BEFORE merging, so a partial upsert (fresh access token, no new refresh token) wiped stored `refreshToken`/`isAdmin` — the same isAdmin-loss class flagged in the 2026-05-01 audit. Fixed to merge raw input over previous, normalize once after.
- **`verifyToken.test` (test harness):** pin `JWT_SECRET` before importing the module that captures it at load.
- **`dispatchService.test` (stale assertion):** asserted `notifiedUsers[0].reportId > 0`, but `notifyDispatch` never receives `reportId` (payload is `{userId, azsId, azsTitle, deadlineAt, timezone, context}`; reportId only appears in an error log). Changed to assert `userId === 11` (the AZS admin recipient) — honest, matches the real contract.

### Verification
- **Full backend suite: 126/126 green, stable across 3 consecutive runs** (first time fully green).
- Sprint-1 feature suites 34/34; C1 recovery + I2 admin-context paths have dedicated tests.
- Each task passed independent spec + code-quality review; all reviewer findings (MySQL double-claim, worker error misclassification, admin-context gate, missing 403 test, C1 stuck-running, I2 scope) fixed and re-verified.
- `node --check server.js` passes.
- **Still pending (needs live DB):** kill-restart smoke in staging — upload photo → kill process mid-sync → restart → confirm `recover()` re-queues the orphaned job and the CRM item syncs.

### Next
- T9 once the operator confirms the prod folder-template string.
- Sprints 2-5 (frontend) per their own plans.

---

## 2026-05-31 — Review of master vs client chat feedback + sprint-10 verification

### Scope
- Branch `master` @ `2e60861`.
- Code review against 6 client requests from the support chat (АЗС photo reports app):
  #1 «отчёт по АЗС / добавить АЗС в выборку», #2 «непонятно как настроить расписание», #3 «задание прилетело управляющему, а должно на аккаунт АЗС», #4 «имена папок/файлов сбились», #5 «внеплановый запрос — нужен мультивыбор АЗС», #6 «кнопка в уведомлении бота → переход к отчёту (выключена)».
- Verification of the other agent's «Sprint 10: admin upload reliability» work.
- Method: 5 parallel read-only Haiku review agents + manual verification of the two P0 findings.

### Findings

| # | Topic | Verdict | Evidence (file:line) |
|---|---|---|---|
| 3 | Notification addressing | **FIXED in code; data/config risk** | recipient = `adminUserId` from AZS entity admin field `UF_CRM_AZS_ADMIN` (`dispatchScheduler.js:185`) → `dispatchService.js:194` → `notificationService.js:52` as `dialogId`. Routes to AZS account, not manager. Residual risk: which user sits in `UF_CRM_AZS_ADMIN` per station is data, not code. |
| 4 | Disk folder naming | **OK in prod (settings override); code defaults stale** | Confirmed by client: already fixed. Mechanism: effective template comes from saved settings `disk.folderNameTemplate` (`reportsRoutes.js:986`, `diskService.js:167`), overridden in the portal to the client-required «date → AZS number» form. ⚠️ Code defaults still hold the OLD 3-level template in TWO places: `defaultSettings.js:43` and `diskService.js:1` (`'{yyyy-mm}/{dd}/{azs}_{azs_name}'`). If settings are ever reset/reinstalled, the regression returns. Recommend aligning both defaults to the agreed template. |
| 4 | Disk file naming | **OK** | `{azs}_{slotDate}_{slotHHmm}_{category}.ext` (`diskService.js:233`) → `4_2026-05-28_1414_Колонки.jpg`. Matches `[Код_АЗС]_[Дата]_[Время]_[Категория].jpg`. |
| 2 | Schedule config UX | **UNCLEAR** | Slot times + jitter set once globally in `settings.client.vue:1149-1185`; reviewer card `reviewer.client.vue:878-959` shows them with label «Времена утренней и дневной рассылки» + removable ×-tags, implying per-day editing. No «set once, runs daily» hint. |
| 5 | Manual multi-select | **Frontend-only gap** | UI single-select `reviewer.client.vue:971-976` (`manualRequest.azsId` string). Backend ALREADY accepts arrays: `resolveManualCandidates` handles `candidates[]` / `azsIds[]` (`reportsRoutes.js:200-206`). |
| 1 | Report by AZS | **Partial** | List + summary accept `azsIds` filter (`reportsRoutes.js:637,670`); `azs-options` endpoint exists (`:682-741`). Gap: `/summary` is portal-wide, no per-AZS breakdown; UI has no AZS filter control. |
| 6 | Bot deep-link button | **Infra present, not wired** | `reportLinks.js:15-26` builds correct `/marketplace/view/{APP_CODE}/?params[path]=/admin/{id}`. `notificationService.js:45-58` supports a `keyboard` param, but `dispatchService.js` notify call does NOT pass it. No feature flag exists yet. |

### Sprint-10 verification (other agent, commit 2e60861)
- Claim 1 (admin sticky panel + «Сдать отчёт» + «Перейти к проблемам»): **CONFIRMED** (`admin/[reportId].client.vue:776-817`).
- Claim 2 (frontend upload queue, x2→x1 on retryable, recover after 10): **CONFIRMED** (`admin/[reportId].client.vue:69-322`).
- Claim 3 (backend CRM-sync serialized per-report queue + backoff `[800,1600,3200]`+jitter, `syncQueued:true`, `errorCode:bitrix_retryable`): **CONFIRMED** (`reportsRoutes.js:505-524,579-598,1010-1066`; `reportCrmSync.js`).

### Risks
- **#4 (resolved in prod; latent regression):** Effective folder template matches client SOP via saved settings. Latent risk: a settings reset/reinstall falls back to the OLD default in `defaultSettings.js:43` + `diskService.js:1`. Cleanup: align both code defaults to the agreed template.
- **CRM-sync queue is in-memory (high):** `reportCrmSyncQueue` is recreated on every process restart (`reportsRoutes.js:613`). A crash/deploy between photo upload (Disk+DB committed, response already 200) and CRM sync **silently loses** the sync → orphaned smart-process item, no retry, no audit, `synced=false` invisible to admin (`reportsRoutes.js:1025-1033`).
- **#3 (medium, data):** If `UF_CRM_AZS_ADMIN` per station points to a manager, the message goes to the manager again — code is correct, mapping must be audited in the portal.
- **#2 (medium, UX):** Misleading labels make schedule config look daily → support load + risk of accidental edits.

### Decision (proposed, pending approval)
- P0: make CRM-sync queue durable (DB-backed retry, surface `synced=false`). Cleanup: align stale folder-template defaults in `defaultSettings.js:43` + `diskService.js:1` so a reinstall can't reintroduce the #4 regression.
- P1: schedule-config UX clarity (#2).
- P2: manual multi-select (#5, frontend-only) + report-by-AZS (#1: surface existing `azsIds` filter on reviewer screen → pick 1 AZS → its summary + list; backend already supports it).
- Backlog/flagged: bot deep-link button (#6) behind `ENABLE_REPORT_DEEP_LINK` until mobile app update ships.
- #3: no code change; add portal data-audit step + a guard log if recipient resolves to a non-AZS role.

### Verification (planned per fix)
- #4: unit test on `buildFolderRelativePath` asserting exact target structure; smoke upload → check Disk tree.
- CRM-sync durability: kill process mid-sync test → on restart pending syncs resume; `synced=false` shown in reviewer.
- #5/#1: `pnpm test` for backend; manual reviewer-screen multi-select + per-AZS summary.

### Next review
- After P0 fixes land: re-verify folder tree on a live report and confirm no CRM-sync loss across a deploy.

---

## 2026-05-01 — Token lifecycle audit + functional coverage

### Scope
- Full audit of OAuth + JWT lifecycle across `frontend/app/stores/api.ts`, `backends/node/api/server.js`, `backends/node/api/src/dispatch/bitrixRestClient.js`, `backends/node/api/src/auth/authContextStore.js`, `backends/node/api/utils/verifyToken.js`.
- Functional coverage check: 15 product features declared in `docs/logs/project-log.md` (sprints 0-10) vs actual code.

### Findings — Functional coverage (15/15 implemented)

| # | Feature | Implementation | Status |
|---|---|---|---|
| 1 | Settings UI (smart-process mapping) | `frontend/app/pages/settings.client.vue:589-636` | OK |
| 2 | Disk module (folder/path/upload + naming) | `backends/node/api/src/disk/diskService.js:1-100` | OK |
| 3 | Dispatch scheduler + jitter + idempotency | `backends/node/api/src/dispatch/{dispatchScheduler.js:190-282,dispatchLogStore.js:24-103}` | OK |
| 4 | Reviewer dashboard KPI/filters | `frontend/app/pages/reviewer.client.vue` + `backends/node/api/src/reports/reportsRoutes.js` | OK |
| 5 | Admin camera-only capture | `frontend/app/pages/admin/[reportId].client.vue:114-275` | OK |
| 6 | Photo upload + EXIF check | `backends/node/api/src/reports/reportsRoutes.js:176-198` | OK (no unit test) |
| 7 | Timeout watcher + EXPIRED transition | `backends/node/api/src/dispatch/timeoutWatcher.js` + `reportCrmSync.js` | OK |
| 8 | Bot-first notification + fallback | `backends/node/api/src/notifications/notificationService.js:51-134` | OK |
| 9 | Bot auto-registration | `backends/node/api/server.js:380-400` + `botRegistryService.js` | OK |
| 10 | REST_APP_URI placement | `backends/node/api/server.js:74-148` | OK |
| 11 | Per-user JWT + per-user Bitrix context | `backends/node/api/src/auth/authContextStore.js:21-28` + `verifyToken.js` | OK (see token findings) |
| 12 | RBAC (admin/reviewer/azs_admin) | `backends/node/api/src/access/roleResolver.js` | OK |
| 13 | `/api/reports/my-active` redirect | `backends/node/api/src/reports/reportsRoutes.js:293-333` | OK |
| 14 | Manual reserve key (`manual:${slotKey}`) | `backends/node/api/src/dispatch/dispatchService.js:20-25` | OK |
| 15 | CRM sync (folderId/photos/stage) | `backends/node/api/src/reports/reportCrmSync.js` | OK |

**Gap:** EXIF validation has no unit test — added in this review.

### Findings — Token lifecycle (7 issues)

| # | Issue | File:Line | Severity |
|---|---|---|---|
| 1 | No 401 interceptor on frontend → after 1h JWT expiry every click breaks UX | `frontend/app/stores/api.ts:52-54, 233-263` | critical |
| 2 | OAuth refresh detector only matches `expired_token` — misses `invalid_token`, `NO_AUTH_FOUND`, `Authorization required`, `wrong_client_id`, `wrong_token`, `INVALID_CREDENTIALS`, `unauthorized` | `backends/node/api/src/dispatch/bitrixRestClient.js:60` | critical |
| 3 | `onTokenRefreshed` overwrites stored context without merging — loses `isAdmin`, `verifiedAt`, `appSid`. After first refresh portal admin loses admin rights | `backends/node/api/server.js:155-162` | critical |
| 4 | `setAuthContext` mutates `process.env.*` and module-level defaults — race condition between concurrent users / scheduler | `backends/node/api/src/dispatch/bitrixRestClient.js:259-279` | high |
| 5 | `getLastAdminContext` falls back to "any context" when no admin exists → scheduler runs under non-admin token, REST calls may be denied | `backends/node/api/src/auth/authContextStore.js:162-178` | high |
| 6 | No strategy for 30-day refresh_token expiry — silent app death after a month without reinstall | (no code) | medium |
| 7 | `/api/getToken` always overwrites `isAdmin = parseBoolean(profile.ADMIN)` — if `profile.ADMIN` is undefined, true → false silently | `backends/node/api/server.js:383-388` | medium |

### Risks

- **App-wide hang after 1h** of inactivity: any AJAX call returns 401, frontend has no recovery → user must reload.
- **Admin escalation loss**: portal admin downgraded to non-admin after first OAuth auto-refresh → settings save denied, scheduler stops.
- **Concurrent user data leak**: `process.env.BITRIX_REST_AUTH_ID` mutating per-call → request A may execute under user B's token (low probability but possible under load).
- **Silent death at 30 days**: no warning, no force-refresh, no admin endpoint to re-auth.

### Decision

Apply 7 fixes (per approved plan `cozy-booping-pizza.md`):
- A. Create this review log file (done with this entry).
- B. Frontend: 401-interceptor + idempotent `reinitToken` + 50-min preventive refresh plugin.
- C. Backend: `isRefreshableAuthError` covers 8 error tokens; `invalid_client` from OAuth endpoint logged separately, not retried.
- D. `onTokenRefreshed` merges over existing context (preserves `isAdmin`, `verifiedAt`, `appSid`).
- E. `setAuthContext` no longer mutates `process.env` per-call; renamed to `setBootstrapContext` for explicit install-time use only.
- F. `getLastAdminContext` returns `null` if no admin exists; scheduler skips tick with warning.
- G. New `tokenRefreshScheduler.js`: hourly cron, warning at 23 days, force-refresh at 29 days; gated by `TOKEN_REFRESH_SCHEDULER_ENABLED=true`.
- H. `/api/getToken` merges `isAdmin` (only overwrites when `profile.ADMIN` is explicitly defined).
- I. Tests: extend `bitrixRestClient.test.js`, `authContextStore.test.js`; add `tokenRefreshScheduler.test.js`, `exifValidation.test.js`.

### Verification

- Backend unit tests: `cd backends/node/api && pnpm test` → all green.
- OAuth refresh smoke: corrupt `authId` in `auth-context.json` → first authenticated request triggers refresh, `isAdmin` preserved.
- Frontend: simulate 401 in DevTools → silent retry, no UI break.
- Pre-refresh scheduler: backdate `refreshTokenIssuedAt` 24/29 days → warning / force-refresh logs appear.
- Race: concurrent scheduler tick + user request → no `process.env` mutation, isolated `auth=` per call.

### Next review

After 30 days of production use — verify pre-refresh scheduler caught at least one near-expiry refresh and no silent token death occurred.

---
