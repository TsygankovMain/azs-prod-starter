# Sprint 3: Disk Module

## PM Summary

Goal:
- Add a reusable backend module that can create Bitrix24 Disk folder structure and upload photo files with stable naming.

Done:
- Implemented disk service with three required public operations:
  - `ensureRootFolder`
  - `ensureFolderPath`
  - `uploadPhoto`
- Implemented default folder path generation rule:
  - `YYYY-MM/DD/АЗС`
- Implemented photo file name rule:
  - `{slotHHmm}_{photoCode}_{isoTimestamp}.{ext}`
- Added safe-name normalization to prevent invalid characters in folder and file names.
- Added unit tests for:
  - path generation
  - filename generation
  - repeated folder creation reusing existing folders
  - upload flow result

Business result:
- Disk behavior is now deterministic and test-covered.
- Future API routes can plug in real Bitrix24 REST adapter without rewriting naming/path logic.

Current limitation:
- This sprint provides a service abstraction and tests.
- Direct calls to Bitrix24 `disk.*` REST methods are planned for integration steps where install/user context tokens are persisted.

## Agent Notes

Files added:
- `backends/node/api/src/disk/diskService.js`
- `backends/node/api/tests/diskService.test.js`

Key logic:
- `buildFolderPath` supports template tokens: `{yyyy}`, `{mm}`, `{dd}`, `{yyyy-mm}`, `{azs}`.
- `buildPhotoFileName` normalizes:
  - slot to digits (`HHmm`)
  - code to safe text
  - timestamp to ISO with `:` replaced by `-`
  - extension to lower-case without leading dot
- `ensureFolderPath` is idempotent by design when adapter returns existing child folders.
- `ensureRootFolder` supports configured static folder ID or dynamic creation under storage root.
- `uploadPhoto` returns summary object with `folderId`, `folderPath`, `fileName`, and upload result metadata.

Verification:

```bash
cd backends/node/api && node --test tests/settings.test.js tests/diskService.test.js
docker exec azs-prod-api-node sh -lc 'node --test tests/settings.test.js tests/diskService.test.js'
```

Verification results:
- Local: 7 tests passed, 0 failed.
- Docker container: 7 tests passed, 0 failed.

Next sprint:
- Sprint 4 Report Dispatch: scheduler, jitter, idempotency table, and push dispatch integration.
