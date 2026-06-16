/**
 * photoRemarkRoutes — HTTP endpoints for the photo-remark journal.
 *
 * UX-2: Per-photo comment contract.
 * NO top-level `message` — comment lives inside each photo object.
 *
 * Routes (mounted at /api/photo-remarks by server.js):
 *   POST /                                  — send batch of photo remarks (per-photo comments)
 *   GET  /                                  — list journal entries with per-photo status
 *   POST /:id/retry                         — retry entire remark (re-send all photos)
 *   POST /:id/retry/:reportId/:photoCode    — retry single photo (UX-2)
 *
 * Factory:
 *   createPhotoRemarkRouter({
 *     remarkStore, photoRemarkService, reportsStore, bitrixClient, getAdminContext
 *   })
 */

import express from 'express';
import { REMARK_NOT_FOUND, PHOTOS_AZS_MISMATCH } from './errorCodes.js';

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
  reportsStore,
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
  // POST / — send a new remark (UX-2 per-photo comment contract)
  //
  // Body (new, FEED-2): {
  //   azsId: string,
  //   azsTitle?: string,
  //   recipientType: "manager" | "admin" | "user",   ← preferred
  //   recipientUserId?: number,                       ← required when type='user'
  //   photos: Array<{ reportId: number, photoCode: string, comment: string }>  // 1..20
  // }
  //
  // Body (legacy, backward-compatible): {
  //   azsId: string,
  //   azsTitle?: string,
  //   recipientRole: "manager" | "admin",             ← old contract, still works
  //   photos: Array<{ reportId: number, photoCode: string, comment: string }>
  // }
  //
  // NO top-level `message`.
  // -------------------------------------------------------------------------
  router.post('/', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    const { azsId, azsTitle, photos } = req.body || {};

    // --- Recipient resolution ---
    // Prefer new recipientType; fall back to old recipientRole for back-compat.
    const recipientType = req.body?.recipientType;
    const recipientRole = req.body?.recipientRole;
    const rawRecipientUserId = req.body?.recipientUserId;

    // Determine effective role/type
    let resolvedRecipientRole = null;   // 'manager' | 'admin' — for role-based lookup
    let resolvedRecipientType = null;   // 'manager' | 'admin' | 'user'
    let resolvedRecipientUserId = null; // number, for type='user'

    if (recipientType) {
      // New contract
      if (recipientType !== 'manager' && recipientType !== 'admin' && recipientType !== 'user') {
        return res.status(400).json({
          error: 'validation_failed',
          message: 'recipientType must be "manager", "admin", or "user"'
        });
      }
      resolvedRecipientType = recipientType;
      if (recipientType === 'user') {
        const uid = Number(rawRecipientUserId);
        if (!Number.isFinite(uid) || uid <= 0) {
          return res.status(400).json({
            error: 'validation_failed',
            message: 'recipientUserId must be a positive number when recipientType is "user"'
          });
        }
        resolvedRecipientUserId = uid;
      } else {
        // 'manager' | 'admin' via recipientType → role-based
        resolvedRecipientRole = recipientType;
      }
    } else {
      // Legacy contract: recipientRole
      if (recipientRole !== 'manager' && recipientRole !== 'admin') {
        return res.status(400).json({
          error: 'validation_failed',
          message: 'recipientRole must be "manager" or "admin"'
        });
      }
      resolvedRecipientRole = recipientRole;
      resolvedRecipientType = recipientRole; // manager/admin
    }

    // Validation
    if (!Array.isArray(photos) || photos.length < 1 || photos.length > 20) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'photos must be an array of 1–20 items'
      });
    }

    // Per-photo comment validation: each photo must have a non-empty comment
    for (let i = 0; i < photos.length; i++) {
      const ph = photos[i];
      if (!ph || typeof ph !== 'object') {
        return res.status(400).json({
          error: 'validation_failed',
          message: `photos[${i}] must be an object`
        });
      }
      if (!String(ph.comment || '').trim()) {
        return res.status(400).json({
          error: 'validation_failed',
          message: `photos[${i}].comment must not be empty`
        });
      }
    }

    if (!String(azsId || '').trim()) {
      return res.status(400).json({ error: 'validation_failed', message: 'azsId is required' });
    }
    // azsTitle: optional, max 200 chars
    const normalizedAzsTitle = azsTitle ? String(azsTitle).trim().slice(0, 200) || null : null;

    try {
      const senderUserId = Number(req.user?.user_id || req.user?.id || 0);
      const adminContext = await resolveAdminCtx(req.bitrixContext || {});
      const senderName = senderUserId
        ? await resolveSenderName(bitrixClient, senderUserId, adminContext)
        : null;

      // I3: verify all photos belong to the claimed azsId
      if (reportsStore) {
        for (const ph of photos) {
          const photoRow = await reportsStore.getPhoto(ph.reportId, ph.photoCode);
          if (photoRow && photoRow.azsId !== undefined && String(photoRow.azsId) !== String(azsId)) {
            return res.status(400).json({
              error: 'validation_failed',
              errorCode: PHOTOS_AZS_MISMATCH,
              message: `Photo ${ph.photoCode} of report ${ph.reportId} belongs to AZS ${photoRow.azsId}, not ${azsId}`
            });
          }
        }
      }

      // Normalize photos: ensure comment is trimmed
      const normalizedPhotos = photos.map((ph) => ({
        reportId: Number(ph.reportId),
        photoCode: String(ph.photoCode),
        comment: String(ph.comment).trim()
      }));

      const record = await photoRemarkService.sendRemark({
        azsId: String(azsId),
        azsTitle: normalizedAzsTitle,
        // Pass both old and new fields; service handles either
        recipientRole: resolvedRecipientRole,
        recipientType: resolvedRecipientType,
        recipientUserId: resolvedRecipientUserId,
        photos: normalizedPhotos,
        sender: { id: senderUserId, name: senderName }
      });

      return res.json({ item: record });
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
  // Returns per-photo entries with their own comment + status.
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
  // POST /:id/retry — retry delivery of ENTIRE remark (all photos)
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

      // Re-deliver to the STORED recipient — no new journal record created
      const result = await photoRemarkService.retryRemark(existing);

      const updated = await remarkStore.getById(id);
      return res.json({ item: updated || result });
    } catch (err) {
      return res.status(500).json({ error: 'remark_retry_failed', message: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /:id/retry/:reportId/:photoCode — retry single photo (UX-2)
  // -------------------------------------------------------------------------
  router.post('/:id/retry/:reportId/:photoCode', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    const remarkId = Number(req.params.id);
    const reportId = Number(req.params.reportId);
    const { photoCode } = req.params;

    if (!Number.isFinite(remarkId) || remarkId <= 0) {
      return res.status(400).json({ error: 'invalid_id', message: 'id must be a positive number' });
    }
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return res.status(400).json({ error: 'invalid_id', message: 'reportId must be a positive number' });
    }
    if (!String(photoCode || '').trim()) {
      return res.status(400).json({ error: 'invalid_id', message: 'photoCode is required' });
    }

    try {
      // Verify parent remark exists
      const existing = await remarkStore.getById(remarkId);
      if (!existing) {
        return res.status(404).json({
          error: 'not_found',
          errorCode: REMARK_NOT_FOUND,
          message: `Remark ${remarkId} not found`
        });
      }

      const result = await photoRemarkService.retryPhoto(remarkId, reportId, photoCode);
      return res.json({ item: result });
    } catch (err) {
      if (err.errorCode) {
        return res.status(err.errorCode === REMARK_NOT_FOUND ? 404 : 422).json({
          error: 'photo_retry_failed',
          errorCode: err.errorCode,
          message: err.message
        });
      }
      return res.status(500).json({ error: 'photo_retry_failed', message: err.message });
    }
  });

  return router;
};

export default createPhotoRemarkRouter;
