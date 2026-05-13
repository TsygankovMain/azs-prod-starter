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
