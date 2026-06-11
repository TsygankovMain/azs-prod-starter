# Sprint 4 Task A2 — Photo Remark Sending + Journal API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the photo remark sending service (bot upload mode + commit fallback), expose POST/GET/retry journal endpoints at `/api/photo-remarks`, extract a shared `resolveAzsRecipients` helper, and mount both routers in `server.js`.

**Architecture:** Five new/modified files: `errorCodes.js` gets two new codes; `azsRecipients.js` extracts recipient resolution from `photoFeedRoutes`; `photoRemarkService.js` handles sending (bot/commit mode) + journal writes; `photoRemarkRoutes.js` exposes the HTTP API; `server.js` mounts both routers. All fakes-based unit tests only — no DB or network required.

**Tech Stack:** Node.js ESM, Express, node:test, node:assert/strict. Bitrix24 REST via `bitrixClient.callMethod`. Existing `photoRemarkStore`, `reportsStore`, `authContextStore`, `settingsStore` as dependencies injected by factory.

**Environment variable:** `PHOTO_FORWARD_MODE=bot` (default) or `commit`. In `bot` mode: per-file `imbot.v2.File.upload` via bot (botId from `process.env.BITRIX_BOT_ID`). In `commit` mode: single `im.disk.file.commit` under admin context.

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `src/reports/errorCodes.js` | Add `RECIPIENT_NOT_SET`, `REMARK_NOT_FOUND` |
| Modify | `src/reports/reportsStore.js` | Add `getPhoto(reportId, photoCode)` method (PG + MySQL) |
| Create | `src/reports/azsRecipients.js` | `resolveAzsRecipients({azsId, settings, bitrixClient, context})` |
| Modify | `src/reports/photoFeedRoutes.js` | Switch `/recipients` to use `resolveAzsRecipients` |
| Create | `src/notifications/photoRemarkService.js` | `createPhotoRemarkService({…})` → `sendRemark(…)` |
| Create | `src/reports/photoRemarkRoutes.js` | `createPhotoRemarkRouter({…})` — POST /, GET /, POST /:id/retry |
| Modify | `server.js` | Mount photoFeedRoutes + photoRemarkRoutes |
| Create | `tests/photoRemarkService.test.js` | Unit tests for service (bot/commit/failure/retry) |
| Create | `tests/photoRemarkRoutes.test.js` | Unit tests for routes (validation/roles/retry 404) |

---

## Task 1: Add error codes to `errorCodes.js`

**Files:**
- Modify: `src/reports/errorCodes.js`

- [ ] **Step 1: Add two new exported constants**

Open `/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api/src/reports/errorCodes.js` and append after `REPORT_NOT_FOUND`:

```js
/**
 * RECIPIENT_NOT_SET
 * The requested recipient role (manager or admin) is not configured for this AZS.
 * meta: { azsId: string, recipientRole: string }
 */
export const RECIPIENT_NOT_SET = 'RECIPIENT_NOT_SET';

/**
 * REMARK_NOT_FOUND
 * The photo_remark record with the given id does not exist.
 * meta: { remarkId: number }
 */
export const REMARK_NOT_FOUND = 'REMARK_NOT_FOUND';
```

- [ ] **Step 2: Verify the file compiles**

```bash
node --input-type=module < /dev/null; node -e "import('./backends/node/api/src/reports/errorCodes.js').then(m=>console.log(Object.keys(m).join(',')))"
```

Run from repo root. Expected output contains: `AZS_PHOTO_SET_EMPTY,AZS_CARD_NOT_FOUND,PHOTO_TYPE_NOT_FOUND,REPORT_NOT_FOUND,RECIPIENT_NOT_SET,REMARK_NOT_FOUND`

---

## Task 2: Add `getPhoto` method to `reportsStore.js`

**Files:**
- Modify: `src/reports/reportsStore.js`

The store already has `listPhotos(reportId)` and `upsertPhoto(…)`. We need a point lookup `getPhoto(reportId, photoCode)` returning `{fileName, diskObjectId, fileId}|null` for both PG and MySQL branches.

- [ ] **Step 1: Add `getPhoto` to the Postgres store object (inside `createPostgresStore`)**

Find the closing brace of `listPhotosFeed` in the PG store (around line 415 — `return { items, nextCursor }; }` then `});`). Add before the closing `});` of `createPostgresStore`:

```js
  async getPhoto(reportId, photoCode) {
    const result = await pool.query(
      `SELECT file_name, disk_object_id, file_id FROM report_photo
       WHERE report_id = $1 AND photo_code = $2 LIMIT 1`,
      [reportId, photoCode]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      fileName: row.file_name || null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
      fileId: row.file_id ? Number(row.file_id) : null
    };
  },
```

- [ ] **Step 2: Add `getPhoto` to the MySQL store object (inside `createMysqlStore`)**

Find the end of the MySQL `listPhotos` method. Add before the closing `});` of `createMysqlStore`:

```js
  async getPhoto(reportId, photoCode) {
    const [rows] = await pool.execute(
      `SELECT file_name, disk_object_id, file_id FROM report_photo
       WHERE report_id = ? AND photo_code = ? LIMIT 1`,
      [reportId, photoCode]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      fileName: row.file_name || null,
      diskObjectId: row.disk_object_id ? Number(row.disk_object_id) : null,
      fileId: row.file_id ? Number(row.file_id) : null
    };
  },
```

- [ ] **Step 3: Run existing tests to confirm no regression**

```bash
cd "/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api"
node --test "tests/*.test.js" 2>&1 | tail -8
```

Expected: `pass 355`, `fail 0`

---

## Task 3: Create `src/reports/azsRecipients.js`

**Files:**
- Create: `src/reports/azsRecipients.js`

Extract the recipient resolution logic from `photoFeedRoutes.js` `/recipients` handler. The module exports a single async function `resolveAzsRecipients`.

Helper functions `parseCrmItemId`, `getFieldValue`, `extractMultipleIds`, `extractFirstUserId`, `resolveUserName` are already defined in `photoFeedRoutes.js` — replicate them here (they are pure utilities; duplication is acceptable since they are unexported private helpers).

- [ ] **Step 1: Write the failing test** (`tests/photoRemarkRoutes.test.js` uses this module, so write it after Task 5. Skip standalone test for azsRecipients — it is covered via integration in service tests.)

- [ ] **Step 2: Create the file**

Create `/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api/src/reports/azsRecipients.js`:

```js
/**
 * azsRecipients — shared recipient resolution for the photo-feed/remark features.
 *
 * resolveAzsRecipients({ azsId, settings, bitrixClient, context })
 *   → { manager: {id, name} | null, admin: {id, name} | null }
 *
 * azsId may be a numeric string or CRM item reference ("CRM_SMART_PROCESS_ITEM_145_42").
 */

const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const getFieldValue = (item, fieldCode) => {
  if (!item || !fieldCode) return undefined;
  const code = String(fieldCode).trim();
  const aliases = [code, code.toLowerCase(), code.toUpperCase()];
  const underscoreMatch = code.match(/^UF_CRM_(\d+)_(\d+)$/i);
  if (underscoreMatch) aliases.push(`ufCrm${underscoreMatch[1]}_${underscoreMatch[2]}`);
  const camelMatch = code.match(/^ufCrm(\d+)_(\d+)$/i);
  if (camelMatch) aliases.push(`UF_CRM_${camelMatch[1]}_${camelMatch[2]}`);
  for (const alias of aliases) {
    if (alias && alias in item && item[alias] !== undefined && item[alias] !== null) {
      return item[alias];
    }
  }
  return undefined;
};

const extractMultipleIds = (value) => {
  if (Array.isArray(value)) return value.flatMap(extractMultipleIds);
  if (value && typeof value === 'object') {
    return extractMultipleIds(value.id ?? value.ID ?? value.value ?? value.VALUE);
  }
  const id = parseCrmItemId(value);
  return id ? [id] : [];
};

const extractFirstUserId = (value) => {
  const ids = extractMultipleIds(value);
  return ids.length ? Number(ids[0]) : 0;
};

const resolveUserName = async (bitrixClient, userId, context = {}) => {
  try {
    if (typeof bitrixClient.callMethod !== 'function') return null;
    const result = await bitrixClient.callMethod('user.get', { ID: userId }, context);
    const users = Array.isArray(result) ? result
      : Array.isArray(result?.result) ? result.result : [];
    const user = users[0];
    if (!user) return null;
    const name = [
      String(user.NAME || '').trim(),
      String(user.LAST_NAME || '').trim()
    ].filter(Boolean).join(' ');
    return name || null;
  } catch {
    return null;
  }
};

/**
 * resolveAzsRecipients
 *
 * @param {object} params
 * @param {string} params.azsId   — CRM item id (numeric string or reference)
 * @param {object} params.settings — app settings (needs settings.azs.entityTypeId, .fields.manager, .fields.admin)
 * @param {object} params.bitrixClient
 * @param {object} [params.context] — Bitrix auth context (admin context recommended)
 * @returns {Promise<{manager: {id:number,name:string|null}|null, admin: {id:number,name:string|null}|null}>}
 */
export const resolveAzsRecipients = async ({
  azsId,
  settings,
  bitrixClient,
  context = {}
}) => {
  const azsItemId = parseCrmItemId(azsId);
  if (!azsItemId) return { manager: null, admin: null };

  const azsEntityTypeId = Number(settings?.azs?.entityTypeId || 0);
  if (!azsEntityTypeId) return { manager: null, admin: null };

  let azsItem = null;
  try {
    azsItem = await bitrixClient.getCrmItem({
      entityTypeId: azsEntityTypeId,
      id: azsItemId,
      context
    });
  } catch {
    // best-effort
  }

  if (!azsItem) return { manager: null, admin: null };

  // ----- manager -----
  let manager = null;
  const managerFieldCode = String(settings?.azs?.fields?.manager || '').trim();
  if (managerFieldCode) {
    const managerUserId = extractFirstUserId(getFieldValue(azsItem, managerFieldCode));
    if (managerUserId > 0) {
      const managerName = await resolveUserName(bitrixClient, managerUserId, context);
      manager = { id: managerUserId, name: managerName };
    }
  }

  // ----- admin -----
  let admin = null;
  const adminFieldCode = String(settings?.azs?.fields?.admin || '').trim();
  if (adminFieldCode) {
    const adminUserId = extractFirstUserId(getFieldValue(azsItem, adminFieldCode));
    if (adminUserId > 0) {
      const adminName = await resolveUserName(bitrixClient, adminUserId, context);
      admin = { id: adminUserId, name: adminName };
    }
  }

  return { manager, admin };
};

export default resolveAzsRecipients;
```

- [ ] **Step 3: Update `photoFeedRoutes.js` to use the shared module**

In `/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api/src/reports/photoFeedRoutes.js`:

Add import at top (after `import express from 'express';`):
```js
import { resolveAzsRecipients } from './azsRecipients.js';
```

Replace the entire body of the `GET /recipients` handler (from `const settings = await settingsStore.read();` to the `return res.json({ manager, admin });` line) with:

```js
    try {
      const settings = await settingsStore.read();

      let context = req.bitrixContext || {};
      if (typeof getAdminContext === 'function') {
        try {
          const adminCtx = await getAdminContext();
          if (adminCtx) context = adminCtx;
        } catch {
          // best-effort
        }
      }

      const { manager, admin } = await resolveAzsRecipients({
        azsId,
        settings,
        bitrixClient,
        context
      });

      return res.json({ manager, admin });
    } catch (err) {
      return res.status(500).json({ error: 'recipients_failed', message: err.message });
    }
```

Also remove the private `parseCrmItemId`, `getFieldValue`, `extractMultipleIds`, `extractFirstUserId` helpers that are no longer used inside `photoFeedRoutes.js`, and remove the private `resolveUserName` function. (They are now in `azsRecipients.js`.) Keep `normDate`, `normIds`, `normLimit`, `normRemarks` — those are feed-specific.

Note: the `/feed` and `/categories` routes still use `parseCrmItemId` (for categories `id` parsing) and `getFieldValue` is not used there, so you can keep `parseCrmItemId` in `photoFeedRoutes.js` if it is still needed locally.

Check if `parseCrmItemId` is used elsewhere in `photoFeedRoutes.js` (it is — for `const azsItemId = parseCrmItemId(azsId);` in `/recipients` AND for categories parsing). Keep it there. Only delete the ones that are PURELY used inside the old inline recipient logic: `getFieldValue`, `extractMultipleIds`, `extractFirstUserId`, and `resolveUserName`.

- [ ] **Step 4: Run existing tests — should still be 355 passing**

```bash
cd "/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api"
node --test "tests/*.test.js" 2>&1 | tail -8
```

Expected: `pass 355`, `fail 0`

---

## Task 4: Create `src/notifications/photoRemarkService.js`

**Files:**
- Create: `src/notifications/photoRemarkService.js`

This service: (1) resolves recipient via `resolveAzsRecipients`, (2) fetches photo file data from `reportsStore.getPhoto`, (3) sends via bot (`imbot.v2.File.upload` per file) or commit (`im.disk.file.commit`), (4) writes journal entry.

BotId is obtained from `process.env.BITRIX_BOT_ID` (numeric). The mode is controlled by `process.env.PHOTO_FORWARD_MODE` (`bot` | `commit`).

**Message format (bot mode):** First file gets text `Замечание по АЗС {azsTitle} ({sender.name}): {message}`. Subsequent files get no message text.

- [ ] **Step 1: Write the failing test** (done in Task 6 — service tests run first to guide implementation)

- [ ] **Step 2: Create the file**

Create `/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api/src/notifications/photoRemarkService.js`:

```js
/**
 * photoRemarkService — sends photo remarks via Bitrix24 bot and writes to the journal.
 *
 * createPhotoRemarkService({ bitrixClient, remarkStore, reportsStore, settingsStore,
 *                             getAdminContext, mode, botId })
 *   → { sendRemark({ azsId, azsTitle, recipientRole, message, photos, sender }) }
 *
 * PHOTO_FORWARD_MODE:
 *   'bot'    (default) — imbot.v2.File.upload per file; text on first file only
 *   'commit'           — im.disk.file.commit with all FILE_ID[] under admin context
 *
 * photos: Array<{ reportId: number, photoCode: string }>
 * sender: { id: number, name: string | null }
 *
 * Returns the journal record (from remarkStore).
 * Always writes a journal record — 'failed' on error, 'sent' on success.
 */

import { resolveAzsRecipients } from '../reports/azsRecipients.js';
import { RECIPIENT_NOT_SET } from '../reports/errorCodes.js';

const resolveMode = (envValue) => {
  const v = String(envValue || '').trim().toLowerCase();
  return v === 'commit' ? 'commit' : 'bot';
};

const buildRemarkText = ({ azsTitle, senderName, message }) => {
  const label = String(azsTitle || '').trim() || '';
  const from = String(senderName || '').trim();
  const text = String(message || '').trim();
  const prefix = label ? `Замечание по АЗС ${label}` : 'Замечание';
  const suffix = from ? ` (${from})` : '';
  return `${prefix}${suffix}: ${text}`;
};

export const createPhotoRemarkService = ({
  bitrixClient,
  remarkStore,
  reportsStore,
  settingsStore,
  getAdminContext,
  mode: modeOverride = null,
  botId: botIdOverride = null
}) => {
  if (!bitrixClient) throw new Error('bitrixClient is required');
  if (!remarkStore) throw new Error('remarkStore is required');
  if (!reportsStore) throw new Error('reportsStore is required');
  if (!settingsStore) throw new Error('settingsStore is required');

  const resolveAdminContext = async (fallback = {}) => {
    if (typeof getAdminContext === 'function') {
      try {
        const ctx = await getAdminContext();
        if (ctx) return ctx;
      } catch {
        // best-effort
      }
    }
    return fallback;
  };

  /**
   * sendRemark — main entry point.
   *
   * @param {object} params
   * @param {string}  params.azsId
   * @param {string}  [params.azsTitle]
   * @param {'manager'|'admin'} params.recipientRole
   * @param {string}  params.message
   * @param {Array<{reportId:number, photoCode:string}>} params.photos  max 20
   * @param {{id:number, name:string|null}} params.sender
   * @returns {Promise<object>} — journal record
   */
  const sendRemark = async ({
    azsId,
    azsTitle = null,
    recipientRole,
    message,
    photos = [],
    sender = {}
  }) => {
    // -----------------------------------------------------------------------
    // 1. Resolve recipient
    // -----------------------------------------------------------------------
    const settings = await settingsStore.read();
    const adminContext = await resolveAdminContext();

    const { manager, admin } = await resolveAzsRecipients({
      azsId,
      settings,
      bitrixClient,
      context: adminContext
    });

    const recipient = recipientRole === 'manager' ? manager : admin;
    if (!recipient || !recipient.id) {
      const err = new Error(`Recipient role "${recipientRole}" is not configured for AZS ${azsId}`);
      err.errorCode = RECIPIENT_NOT_SET;
      throw err;
    }

    const mode = resolveMode(modeOverride ?? process.env.PHOTO_FORWARD_MODE);
    const botId = Number(botIdOverride ?? process.env.BITRIX_BOT_ID ?? 0);
    const remarkText = buildRemarkText({ azsTitle, senderName: sender?.name, message });

    // -----------------------------------------------------------------------
    // 2. Insert journal record (initial status 'sent', will be overwritten on failure)
    // -----------------------------------------------------------------------
    const record = await remarkStore.insertRemark({
      azsId,
      azsTitle: azsTitle ?? null,
      recipientRole,
      recipientUserId: recipient.id,
      recipientName: recipient.name ?? null,
      message,
      senderUserId: sender?.id ?? null,
      senderName: sender?.name ?? null,
      photos
    });

    // -----------------------------------------------------------------------
    // 3. Send
    // -----------------------------------------------------------------------
    try {
      if (mode === 'commit') {
        // ------------------------------------------------------------------
        // commit mode: im.disk.file.commit with all disk_object_ids
        // ------------------------------------------------------------------
        const fileIds = [];
        for (const { reportId, photoCode } of photos) {
          const photo = await reportsStore.getPhoto(reportId, photoCode);
          if (photo?.diskObjectId) {
            fileIds.push(photo.diskObjectId);
          }
        }

        await bitrixClient.callMethod('im.disk.file.commit', {
          DIALOG_ID: String(recipient.id),
          FILE_ID: fileIds,
          MESSAGE: remarkText
        }, adminContext);
      } else {
        // ------------------------------------------------------------------
        // bot mode: imbot.v2.File.upload per file
        // ------------------------------------------------------------------
        if (!botId) {
          throw new Error('BITRIX_BOT_ID is required for PHOTO_FORWARD_MODE=bot');
        }

        let isFirst = true;
        for (const { reportId, photoCode } of photos) {
          const photo = await reportsStore.getPhoto(reportId, photoCode);
          if (!photo?.diskObjectId) continue;

          const { base64, name } = await bitrixClient.diskApi.downloadFileContent(
            photo.diskObjectId,
            adminContext
          );

          const fields = {
            FILE: {
              name: photo.fileName || name,
              content: base64
            }
          };
          if (isFirst) {
            fields.FILE.message = remarkText;
            isFirst = false;
          }

          await bitrixClient.callMethod('imbot.v2.File.upload', {
            botId: Number(botId),
            dialogId: String(recipient.id),
            fields
          }, adminContext);
        }
      }

      // success — record already has status 'sent' from insertRemark
      await remarkStore.markDelivery(record.id, 'sent', null);
      return { ...record, deliveryStatus: 'sent', deliveryError: null };
    } catch (err) {
      const errorText = String(err?.message || err || 'unknown error').slice(0, 1000);
      await remarkStore.markDelivery(record.id, 'failed', errorText);
      return { ...record, deliveryStatus: 'failed', deliveryError: errorText };
    }
  };

  return { sendRemark };
};

export default createPhotoRemarkService;
```

---

## Task 5: Create `src/reports/photoRemarkRoutes.js`

**Files:**
- Create: `src/reports/photoRemarkRoutes.js`

Sender name: resolved via `user.get` under admin context. Cache per process (Map: userId → name).

- [ ] **Step 1: Create the file**

Create `/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api/src/reports/photoRemarkRoutes.js`:

```js
/**
 * photoRemarkRoutes — HTTP endpoints for the photo-remark journal.
 *
 * Routes (mounted at /api/photo-remarks by server.js):
 *   POST /          — send remark + write journal
 *   GET  /          — list journal entries
 *   POST /:id/retry — retry delivery of a failed remark
 *
 * Factory:
 *   createPhotoRemarkRouter({
 *     remarkStore, photoRemarkService, bitrixClient, getAdminContext
 *   })
 */

import express from 'express';
import { REMARK_NOT_FOUND } from './errorCodes.js';

// ---------------------------------------------------------------------------
// Guards — same pattern as photoFeedRoutes / analyticsRoutes
// ---------------------------------------------------------------------------

const canReview = (req) => (
  Boolean(req.accessContext?.capabilities?.reviewer) ||
  Boolean(req.accessContext?.capabilities?.settings)
);

// ---------------------------------------------------------------------------
// Param normalizers
// ---------------------------------------------------------------------------

const normDate = (v) => {
  const r = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(r) ? r : '';
};

const normIds = (v) => {
  const src = Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/g);
  return [...new Set(src.map((s) => String(s || '').trim()).filter(Boolean))];
};

const normLimit = (v, max = 100) => {
  const n = Math.floor(Number(v) || 50);
  return Math.min(Math.max(n, 1), max);
};

// ---------------------------------------------------------------------------
// Process-level sender name cache
// ---------------------------------------------------------------------------

const senderNameCache = new Map(); // userId → name | null

const resolveSenderName = async (bitrixClient, userId, adminContext) => {
  if (senderNameCache.has(userId)) return senderNameCache.get(userId);
  try {
    const result = await bitrixClient.callMethod('user.get', { ID: userId }, adminContext);
    const users = Array.isArray(result) ? result
      : Array.isArray(result?.result) ? result.result : [];
    const user = users[0];
    const name = user
      ? [String(user.NAME || '').trim(), String(user.LAST_NAME || '').trim()]
          .filter(Boolean).join(' ') || null
      : null;
    senderNameCache.set(userId, name);
    return name;
  } catch {
    senderNameCache.set(userId, null);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createPhotoRemarkRouter = ({
  remarkStore,
  photoRemarkService,
  bitrixClient,
  getAdminContext
}) => {
  if (!remarkStore) throw new Error('remarkStore is required');
  if (!photoRemarkService) throw new Error('photoRemarkService is required');
  if (!bitrixClient) throw new Error('bitrixClient is required');

  const router = express.Router();

  const resolveAdminCtx = async (fallback = {}) => {
    if (typeof getAdminContext === 'function') {
      try {
        const ctx = await getAdminContext();
        if (ctx) return ctx;
      } catch {
        // best-effort
      }
    }
    return fallback;
  };

  // -------------------------------------------------------------------------
  // POST / — send a new remark
  // -------------------------------------------------------------------------
  router.post('/', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    const { azsId, azsTitle, recipientRole, message, photos } = req.body || {};

    // Validation
    if (!String(message || '').trim()) {
      return res.status(400).json({ error: 'validation_failed', message: 'message must not be empty' });
    }
    if (!Array.isArray(photos) || photos.length < 1 || photos.length > 20) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'photos must be an array of 1–20 items'
      });
    }
    if (recipientRole !== 'manager' && recipientRole !== 'admin') {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'recipientRole must be "manager" or "admin"'
      });
    }
    if (!String(azsId || '').trim()) {
      return res.status(400).json({ error: 'validation_failed', message: 'azsId is required' });
    }

    try {
      const senderUserId = Number(req.user?.user_id || req.user?.id || 0);
      const adminContext = await resolveAdminCtx(req.bitrixContext || {});
      const senderName = senderUserId
        ? await resolveSenderName(bitrixClient, senderUserId, adminContext)
        : null;

      const record = await photoRemarkService.sendRemark({
        azsId: String(azsId),
        azsTitle: azsTitle ? String(azsTitle) : null,
        recipientRole,
        message: String(message).trim(),
        photos,
        sender: { id: senderUserId, name: senderName }
      });

      return res.json(record);
    } catch (err) {
      if (err.errorCode) {
        return res.status(422).json({
          error: 'remark_send_failed',
          errorCode: err.errorCode,
          message: err.message
        });
      }
      return res.status(500).json({ error: 'remark_send_failed', message: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET / — list journal entries
  // -------------------------------------------------------------------------
  router.get('/', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    const dateFrom = normDate(req.query.dateFrom);
    const dateTo = normDate(req.query.dateTo);
    const azsIds = normIds(req.query.azsId);
    const limit = normLimit(req.query.limit, 100);
    const cursor = String(req.query.cursor || '').trim() || null;

    try {
      const result = await remarkStore.list({ dateFrom, dateTo, azsIds, limit, cursor });
      return res.json({ items: result.items, nextCursor: result.nextCursor });
    } catch (err) {
      return res.status(500).json({ error: 'remark_list_failed', message: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /:id/retry — retry delivery of a failed remark
  // -------------------------------------------------------------------------
  router.post('/:id/retry', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id', message: 'id must be a positive number' });
    }

    try {
      const existing = await remarkStore.getById(id);
      if (!existing) {
        return res.status(404).json({
          error: 'not_found',
          errorCode: REMARK_NOT_FOUND,
          message: `Remark ${id} not found`
        });
      }

      // Re-send using the same parameters stored in the journal record
      const record = await photoRemarkService.sendRemark({
        azsId: existing.azsId,
        azsTitle: existing.azsTitle,
        recipientRole: existing.recipientRole,
        message: existing.message,
        photos: existing.photos || [],
        sender: { id: existing.senderUserId, name: existing.senderName }
      });

      // Update the ORIGINAL record's delivery status
      await remarkStore.markDelivery(id, record.deliveryStatus, record.deliveryError ?? null);

      const updated = await remarkStore.getById(id);
      return res.json(updated || record);
    } catch (err) {
      return res.status(500).json({ error: 'remark_retry_failed', message: err.message });
    }
  });

  return router;
};

export default createPhotoRemarkRouter;
```

---

## Task 6: Write and run `tests/photoRemarkService.test.js`

**Files:**
- Create: `tests/photoRemarkService.test.js`

These tests use entirely in-memory fakes — no DB, no HTTP, no actual Bitrix calls.

- [ ] **Step 1: Create the test file**

Create `/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api/tests/photoRemarkService.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoRemarkService } from '../src/notifications/photoRemarkService.js';

// ---------------------------------------------------------------------------
// Fake remarkStore
// ---------------------------------------------------------------------------

const createFakeRemarkStore = () => {
  let seq = 0;
  const records = new Map();

  return {
    async insertRemark(data) {
      seq += 1;
      const record = {
        id: seq,
        createdAt: new Date().toISOString(),
        azsId: data.azsId || '',
        azsTitle: data.azsTitle ?? null,
        recipientRole: data.recipientRole,
        recipientUserId: data.recipientUserId ?? null,
        recipientName: data.recipientName ?? null,
        message: data.message || '',
        senderUserId: data.senderUserId ?? null,
        senderName: data.senderName ?? null,
        deliveryStatus: 'sent',
        deliveryError: null,
        photos: data.photos || []
      };
      records.set(seq, { ...record });
      return record;
    },
    async markDelivery(id, status, error = null) {
      const r = records.get(id);
      if (r) { r.deliveryStatus = status; r.deliveryError = error; }
    },
    async getById(id) {
      return records.get(id) ?? null;
    },
    records
  };
};

// ---------------------------------------------------------------------------
// Fake reportsStore
// ---------------------------------------------------------------------------

const createFakeReportsStore = (photosByKey = {}) => ({
  async getPhoto(reportId, photoCode) {
    return photosByKey[`${reportId}:${photoCode}`] ?? null;
  }
});

// ---------------------------------------------------------------------------
// Fake settingsStore
// ---------------------------------------------------------------------------

const makeSettings = (overrides = {}) => ({
  azs: {
    entityTypeId: 145,
    fields: { manager: 'UF_CRM_1_1000', admin: 'UF_CRM_1_2000' },
    ...overrides.azs
  },
  ...overrides
});

const createFakeSettingsStore = (settings = makeSettings()) => ({
  async read() { return settings; }
});

// ---------------------------------------------------------------------------
// Fake bitrixClient
// ---------------------------------------------------------------------------

const createFakeBitrixClient = ({
  azsItem = { id: 42, ufCrm1_1000: 10, ufCrm1_2000: 20 },
  managerName = 'Менеджер И.',
  adminName = 'Админ П.',
  uploadCalls = [],
  commitCalls = [],
  failOnUploadIndex = -1 // which upload call (0-based) should throw
} = {}) => ({
  async getCrmItem({ id }) {
    return id === 42 ? azsItem : null;
  },
  async callMethod(method, params) {
    if (method === 'user.get') {
      const id = Number(params?.ID || 0);
      if (id === 10) return [{ ID: 10, NAME: managerName.split(' ')[0], LAST_NAME: managerName.split(' ')[1] || '' }];
      if (id === 20) return [{ ID: 20, NAME: adminName.split(' ')[0], LAST_NAME: adminName.split(' ')[1] || '' }];
      return [];
    }
    if (method === 'imbot.v2.File.upload') {
      const idx = uploadCalls.length;
      uploadCalls.push(params);
      if (idx === failOnUploadIndex) throw new Error('upload_failed_on_second');
    }
    if (method === 'im.disk.file.commit') {
      commitCalls.push(params);
    }
    return {};
  },
  diskApi: {
    async downloadFileContent(diskObjectId) {
      return { base64: Buffer.from(`content_${diskObjectId}`).toString('base64'), name: `file_${diskObjectId}.jpg` };
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeService = (overrides = {}) => {
  const remarkStore = overrides.remarkStore ?? createFakeRemarkStore();
  const reportsStore = overrides.reportsStore ?? createFakeReportsStore({
    '10:front': { diskObjectId: 1001, fileName: 'front.jpg', fileId: 9001 },
    '10:side':  { diskObjectId: 1002, fileName: 'side.jpg',  fileId: 9002 },
    '10:back':  { diskObjectId: 1003, fileName: 'back.jpg',  fileId: 9003 }
  });
  const settingsStore = overrides.settingsStore ?? createFakeSettingsStore();
  const bitrixClient = overrides.bitrixClient ?? createFakeBitrixClient();
  const getAdminContext = overrides.getAdminContext ?? (async () => ({ authId: 'admin-token' }));

  const svc = createPhotoRemarkService({
    bitrixClient,
    remarkStore,
    reportsStore,
    settingsStore,
    getAdminContext,
    mode: overrides.mode ?? 'bot',
    botId: overrides.botId ?? 5
  });

  return { svc, remarkStore, bitrixClient };
};

// ---------------------------------------------------------------------------
// Tests — bot mode
// ---------------------------------------------------------------------------

test('bot mode: 3 photos → 3 upload calls, text on first only', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const { svc, remarkStore } = makeService({ bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС Север', recipientRole: 'manager',
    message: 'Плохой порядок',
    photos: [
      { reportId: 10, photoCode: 'front' },
      { reportId: 10, photoCode: 'side' },
      { reportId: 10, photoCode: 'back' }
    ],
    sender: { id: 3, name: 'Проверяющий А.' }
  });

  assert.equal(result.deliveryStatus, 'sent');
  assert.equal(uploadCalls.length, 3, 'should be 3 upload calls');

  // Text only on first file
  assert.ok(uploadCalls[0].fields.FILE.message, 'first upload should have message');
  assert.ok(uploadCalls[0].fields.FILE.message.includes('АЗС Север'), 'message contains azsTitle');
  assert.ok(uploadCalls[0].fields.FILE.message.includes('Проверяющий А.'), 'message contains sender name');
  assert.ok(uploadCalls[0].fields.FILE.message.includes('Плохой порядок'), 'message contains text');
  assert.equal(uploadCalls[1].fields.FILE.message, undefined, 'second upload should have no message');
  assert.equal(uploadCalls[2].fields.FILE.message, undefined, 'third upload should have no message');

  // Journal record
  const stored = remarkStore.records.get(result.id);
  assert.equal(stored.deliveryStatus, 'sent');
});

test('bot mode: failure on 2nd upload → status failed, record exists', async () => {
  const uploadCalls = [];
  const bitrixClient = createFakeBitrixClient({ uploadCalls, failOnUploadIndex: 1 });
  const { svc, remarkStore } = makeService({ bitrixClient });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: null, recipientRole: 'manager',
    message: 'Test failure',
    photos: [
      { reportId: 10, photoCode: 'front' },
      { reportId: 10, photoCode: 'side' }
    ],
    sender: { id: 3, name: 'Тест' }
  });

  assert.equal(result.deliveryStatus, 'failed', 'should be failed on upload error');
  assert.ok(result.deliveryError, 'should have error text');
  // Journal record must exist
  assert.ok(remarkStore.records.size > 0, 'record must be written even on failure');
  const stored = [...remarkStore.records.values()][0];
  assert.equal(stored.deliveryStatus, 'failed');
});

test('bot mode: RECIPIENT_NOT_SET when manager not in AZS card', async () => {
  const bitrixClient = createFakeBitrixClient({
    azsItem: { id: 42 } // no manager field
  });
  const { svc } = makeService({ bitrixClient });

  await assert.rejects(
    () => svc.sendRemark({
      azsId: '42', recipientRole: 'manager', message: 'test',
      photos: [{ reportId: 10, photoCode: 'front' }],
      sender: { id: 1, name: 'Кто-то' }
    }),
    (err) => {
      assert.equal(err.errorCode, 'RECIPIENT_NOT_SET');
      return true;
    }
  );
});

test('commit mode: single im.disk.file.commit with FILE_ID array', async () => {
  const commitCalls = [];
  const bitrixClient = createFakeBitrixClient({ commitCalls });
  const { svc } = makeService({ bitrixClient, mode: 'commit' });

  const result = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС Юг', recipientRole: 'admin',
    message: 'Грязь на колонках',
    photos: [
      { reportId: 10, photoCode: 'front' },
      { reportId: 10, photoCode: 'back' }
    ],
    sender: { id: 5, name: 'Ревизор' }
  });

  assert.equal(result.deliveryStatus, 'sent');
  assert.equal(commitCalls.length, 1, 'only one commit call');
  assert.ok(Array.isArray(commitCalls[0].FILE_ID), 'FILE_ID should be array');
  assert.equal(commitCalls[0].FILE_ID.length, 2, 'two file ids');
  assert.ok(commitCalls[0].MESSAGE.includes('АЗС Юг'));
});

test('retry: re-sending a failed remark → markDelivery called with sent', async () => {
  const uploadCalls = [];
  const remarkStore = createFakeRemarkStore();
  const bitrixClient = createFakeBitrixClient({ uploadCalls });
  const { svc } = makeService({ remarkStore, bitrixClient });

  // First send succeeds
  const first = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС', recipientRole: 'manager',
    message: 'msg', photos: [{ reportId: 10, photoCode: 'front' }],
    sender: { id: 1, name: 'Ревизор' }
  });

  // Simulate marking as failed manually
  await remarkStore.markDelivery(first.id, 'failed', 'network error');

  // Retry (resend same data)
  const retried = await svc.sendRemark({
    azsId: '42', azsTitle: 'АЗС', recipientRole: 'manager',
    message: 'msg', photos: [{ reportId: 10, photoCode: 'front' }],
    sender: { id: 1, name: 'Ревизор' }
  });

  assert.equal(retried.deliveryStatus, 'sent', 'retry should succeed');
});
```

- [ ] **Step 2: Run just these tests — expect them to pass**

```bash
cd "/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api"
node --test "tests/photoRemarkService.test.js" 2>&1 | tail -10
```

Expected: all 5 tests pass. If any fail, fix `photoRemarkService.js` and re-run.

---

## Task 7: Write and run `tests/photoRemarkRoutes.test.js`

**Files:**
- Create: `tests/photoRemarkRoutes.test.js`

- [ ] **Step 1: Create the test file**

Create `/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api/tests/photoRemarkRoutes.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoRemarkRouter } from '../src/reports/photoRemarkRoutes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200,
    _headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p)   { this._payload = p; return p; },
    setHeader(k, v) { this._headers[k] = v; },
    send(b)   { this._body = b; }
  };
}

function makeReq(overrides = {}) {
  return {
    params: {},
    query: {},
    body: {},
    user: { id: 3, user_id: 3 },
    accessContext: { capabilities: { reviewer: true } },
    bitrixContext: {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const createFakeRemarkStore = () => {
  let seq = 0;
  const records = new Map();
  return {
    async insertRemark(data) {
      seq += 1;
      const r = {
        id: seq, createdAt: new Date().toISOString(),
        azsId: data.azsId, azsTitle: data.azsTitle ?? null,
        recipientRole: data.recipientRole, recipientUserId: data.recipientUserId ?? null,
        recipientName: data.recipientName ?? null, message: data.message,
        senderUserId: data.senderUserId ?? null, senderName: data.senderName ?? null,
        deliveryStatus: 'sent', deliveryError: null, photos: data.photos || []
      };
      records.set(seq, { ...r });
      return r;
    },
    async markDelivery(id, status, error = null) {
      const r = records.get(id);
      if (r) { r.deliveryStatus = status; r.deliveryError = error; }
    },
    async getById(id) { return records.get(id) ?? null; },
    async list({ limit = 10 } = {}) {
      const items = [...records.values()].slice(0, limit);
      return { items, nextCursor: null };
    }
  };
};

const createFakeService = (overrides = {}) => ({
  async sendRemark(params) {
    if (overrides.throwCode) {
      const err = new Error('test error');
      err.errorCode = overrides.throwCode;
      throw err;
    }
    return {
      id: 99, azsId: params.azsId, recipientRole: params.recipientRole,
      message: params.message, deliveryStatus: 'sent', deliveryError: null,
      photos: params.photos || [], createdAt: new Date().toISOString()
    };
  }
});

const fakeBitrixClient = {
  async callMethod(method, params) {
    if (method === 'user.get') {
      return [{ ID: params.ID, NAME: 'Тест', LAST_NAME: 'Юзер' }];
    }
    return {};
  }
};

const stubDeps = {
  remarkStore: createFakeRemarkStore(),
  photoRemarkService: createFakeService(),
  bitrixClient: fakeBitrixClient,
  getAdminContext: async () => ({ authId: 'admin-token' })
};

// ---------------------------------------------------------------------------
// Route handler helper (same pattern as photoFeed.test.js)
// ---------------------------------------------------------------------------

function getHandler(router, method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const route = layer.route;
      const match = route.path === pathPattern || String(route.path).startsWith(pathPattern.replace('/:id', '/'));
      const hasMethod = route.stack.some((l) => !method || l.method === method.toLowerCase() || !l.method);
      if (match && hasMethod) {
        // Return the handler that matches method
        const h = route.stack.find((l) => !method || l.method === method.toLowerCase() || !l.method);
        return h?.handle || null;
      }
    }
  }
  return null;
}

function findRoute(router, method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const route = layer.route;
      if (route.path === pathPattern) {
        const h = route.stack.find((l) => l.method === method.toLowerCase());
        return h?.handle || null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests — POST /
// ---------------------------------------------------------------------------

test('POST / returns 403 without reviewer role', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('POST / returns 400 when message is empty', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: '', photos: [{ reportId: 1, photoCode: 'a' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res._payload?.message?.includes('message'));
});

test('POST / returns 400 when photos is empty array', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: 'test', photos: [] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('POST / returns 400 when photos has more than 20 items', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const photos = Array.from({ length: 21 }, (_, i) => ({ reportId: 1, photoCode: String(i) }));
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: 'test', photos }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('POST / returns 400 when recipientRole is invalid', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'owner', message: 'test', photos: [{ reportId: 1, photoCode: 'a' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

test('POST / returns 200 on successful send', async () => {
  const router = createPhotoRemarkRouter({
    ...stubDeps,
    remarkStore: createFakeRemarkStore()
  });
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: 'Замечание', photos: [{ reportId: 10, photoCode: 'front' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res._payload?.azsId);
});

test('POST / returns 422 on RECIPIENT_NOT_SET errorCode', async () => {
  const deps = {
    ...stubDeps,
    photoRemarkService: createFakeService({ throwCode: 'RECIPIENT_NOT_SET' })
  };
  const router = createPhotoRemarkRouter(deps);
  const handler = findRoute(router, 'post', '/');
  if (!handler) return;
  const req = makeReq({
    body: { azsId: '42', recipientRole: 'manager', message: 'test', photos: [{ reportId: 1, photoCode: 'a' }] }
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res._payload?.errorCode, 'RECIPIENT_NOT_SET');
});

// ---------------------------------------------------------------------------
// Tests — GET /
// ---------------------------------------------------------------------------

test('GET / returns 403 without reviewer role', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq({ accessContext: { capabilities: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('GET / returns items and nextCursor', async () => {
  const remarkStore = createFakeRemarkStore();
  await remarkStore.insertRemark({ azsId: '1', recipientRole: 'admin', message: 'a', photos: [] });
  const deps = { ...stubDeps, remarkStore };
  const router = createPhotoRemarkRouter(deps);
  const handler = findRoute(router, 'get', '/');
  if (!handler) return;
  const req = makeReq({ query: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res._payload?.items));
  assert.equal(res._payload.items.length, 1);
  assert.ok('nextCursor' in res._payload);
});

// ---------------------------------------------------------------------------
// Tests — POST /:id/retry
// ---------------------------------------------------------------------------

test('POST /:id/retry returns 404 with REMARK_NOT_FOUND for unknown id', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  // Find the retry route
  let retryHandler = null;
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/retry') {
      const h = layer.route.stack.find((l) => l.method === 'post');
      retryHandler = h?.handle || null;
    }
  }
  if (!retryHandler) return;
  const req = makeReq({ params: { id: '9999' } });
  const res = makeRes();
  await retryHandler(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res._payload?.errorCode, 'REMARK_NOT_FOUND');
});

test('POST /:id/retry returns 403 without reviewer role', async () => {
  const router = createPhotoRemarkRouter(stubDeps);
  let retryHandler = null;
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/retry') {
      const h = layer.route.stack.find((l) => l.method === 'post');
      retryHandler = h?.handle || null;
    }
  }
  if (!retryHandler) return;
  const req = makeReq({ params: { id: '1' }, accessContext: { capabilities: {} } });
  const res = makeRes();
  await retryHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test('POST /:id/retry succeeds for existing remark', async () => {
  const remarkStore = createFakeRemarkStore();
  const inserted = await remarkStore.insertRemark({
    azsId: '42', recipientRole: 'admin', message: 'test', photos: [{ reportId: 10, photoCode: 'front' }]
  });
  await remarkStore.markDelivery(inserted.id, 'failed', 'timeout');

  const deps = { ...stubDeps, remarkStore };
  const router = createPhotoRemarkRouter(deps);
  let retryHandler = null;
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/retry') {
      const h = layer.route.stack.find((l) => l.method === 'post');
      retryHandler = h?.handle || null;
    }
  }
  if (!retryHandler) return;
  const req = makeReq({ params: { id: String(inserted.id) } });
  const res = makeRes();
  await retryHandler(req, res);
  assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

test('createPhotoRemarkRouter throws when remarkStore is missing', () => {
  assert.throws(
    () => createPhotoRemarkRouter({ photoRemarkService: {}, bitrixClient: {} }),
    /remarkStore is required/
  );
});

test('createPhotoRemarkRouter throws when photoRemarkService is missing', () => {
  assert.throws(
    () => createPhotoRemarkRouter({ remarkStore: {}, bitrixClient: {} }),
    /photoRemarkService is required/
  );
});

test('createPhotoRemarkRouter throws when bitrixClient is missing', () => {
  assert.throws(
    () => createPhotoRemarkRouter({ remarkStore: {}, photoRemarkService: {} }),
    /bitrixClient is required/
  );
});
```

- [ ] **Step 2: Run just these tests**

```bash
cd "/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api"
node --test "tests/photoRemarkRoutes.test.js" 2>&1 | tail -10
```

Expected: all tests pass. If any fail, fix the routes file and re-run.

---

## Task 8: Mount routers in `server.js`

**Files:**
- Modify: `server.js`

The analytics router is mounted via `createAnalyticsRouter` inside `createReportsRouter`. The photo-feed and photo-remark routers are mounted at the top level.

Pattern to follow: how `reports` router is mounted at line ~409–423 in `server.js`.

- [ ] **Step 1: Add imports to `server.js`**

After the line `import { resolveAccessContext } from './src/access/roleResolver.js';`, add:

```js
import { createPhotoFeedRouter } from './src/reports/photoFeedRoutes.js';
import createPhotoRemarkStore from './src/reports/photoRemarkStore.js';
import { createPhotoRemarkService } from './src/notifications/photoRemarkService.js';
import { createPhotoRemarkRouter } from './src/reports/photoRemarkRoutes.js';
```

- [ ] **Step 2: Add store instantiation after the existing stores block**

After the line `const reasonStore = createReasonStore({ pool, dbType });`, add:

```js
const photoRemarkStore = createPhotoRemarkStore({ pool, dbType });
```

- [ ] **Step 3: Add a `getAdminContext` helper near the existing factory usages**

After the `settingsStore` definition block, add:

```js
const getAdminContext = async () => {
  const entry = await authContextStore.getLastAdminContext();
  if (!entry?.context) return {};
  return { key: entry.key, ...entry.context };
};
```

- [ ] **Step 4: Instantiate the service**

After `const reasonForwardingService = …;`, add:

```js
const photoRemarkService = createPhotoRemarkService({
  bitrixClient,
  remarkStore: photoRemarkStore,
  reportsStore,
  settingsStore,
  getAdminContext
});
```

- [ ] **Step 5: Mount both routers**

After the existing `app.use('/api/reports', …)` block, add:

```js
app.use('/api/reports/photos', verifyToken, attachAccessContext, createPhotoFeedRouter({
  reportsStore,
  settingsStore,
  bitrixClient,
  getAdminContext
}));

app.use('/api/photo-remarks', verifyToken, attachAccessContext, createPhotoRemarkRouter({
  remarkStore: photoRemarkStore,
  photoRemarkService,
  bitrixClient,
  getAdminContext
}));
```

- [ ] **Step 6: Add schema initialization for photoRemarkStore**

After the `reasonStore.ensureSchema()` block, add:

```js
photoRemarkStore.ensureSchema()
  .then(() => console.log('photo_remark schema is ready'))
  .catch((error) => console.error('Failed to prepare photo_remark schema', error));
```

- [ ] **Step 7: Verify server.js has no syntax errors**

```bash
cd "/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api"
node --check server.js 2>&1
```

Expected: no output (no errors).

---

## Task 9: Full test suite run + commit

**Files:**
- No new files

- [ ] **Step 1: Run the full test suite**

```bash
cd "/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter/backends/node/api"
node --test "tests/*.test.js" 2>&1 | tail -10
```

Expected: `pass 372` (355 original + 5 service tests + ~16 route tests), `fail 0`. Actual number may vary slightly based on test count; key requirement is `fail 0`.

- [ ] **Step 2: Stage only the modified/created files**

```bash
cd "/Users/tsygankovegor/Documents/Приложения для Битрикс24/АЗС прод/azs-prod-starter"
git add \
  backends/node/api/src/reports/errorCodes.js \
  backends/node/api/src/reports/reportsStore.js \
  backends/node/api/src/reports/azsRecipients.js \
  backends/node/api/src/reports/photoFeedRoutes.js \
  backends/node/api/src/notifications/photoRemarkService.js \
  backends/node/api/src/reports/photoRemarkRoutes.js \
  backends/node/api/server.js \
  backends/node/api/tests/photoRemarkService.test.js \
  backends/node/api/tests/photoRemarkRoutes.test.js
```

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(photos): remark sending via bot + journal API (PHOTO_FORWARD_MODE)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec §5.2 coverage:**
- `POST /api/photo-remarks` — Task 5 (routes) + Task 4 (service). Covered.
- `GET /api/photo-remarks?view=time|azs&…` — GET / in Task 5 delegates to `remarkStore.list`. The `view` param is noted in spec as "группировка на фронте"; backend returns flat list. Covered per spec note.
- `POST /api/photo-remarks/:id/retry` — Task 5. Covered.
- `GET /api/reports/photos/feed` + `/categories` + `/recipients` — existing, mounted in Task 8. Covered.

**Spec §6 coverage:**
- Bot mode (`imbot.v2.File.upload`) — Task 4. Covered.
- Text on first file only — Task 4 + tested in Task 6. Covered.
- `downloadFileContent` for binary content — Task 4. Covered.
- `callWithTransientRetry` — note: `bitrixClient.callMethod` already wraps calls with transient retry internally (per `bitrixRestClient.js` line 354–358). No extra wrapping needed in service.
- Commit fallback mode — Task 4 + tested in Task 6. Covered.
- Journal: always written, both failure and success paths — Task 4 + tested in Task 6. Covered.
- `RECIPIENT_NOT_SET` error code — Task 1 + Task 4 + Task 7. Covered.

**Placeholder scan:** No TBDs. All steps have real code.

**Type consistency:**
- `remarkStore` is consistent: `insertRemark`, `markDelivery`, `getById`, `list` — same names used in Task 4 (service), Task 5 (routes), Task 6 (tests), Task 7 (tests).
- `photoRemarkService.sendRemark({…})` — consistent between Task 4, Task 5, Task 7.
- `reportsStore.getPhoto(reportId, photoCode)` — defined in Task 2, called in Task 4, faked in Task 6.
- `resolveAzsRecipients({azsId, settings, bitrixClient, context})` — defined in Task 3, imported in Task 4. Consistent.

**PHOTO_FORWARD_MODE:** Documented in this plan. Not added to `.env.example` per task instructions (another agent owns that file).
