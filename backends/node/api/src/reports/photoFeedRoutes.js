/**
 * photoFeedRoutes — Express router for the photo-feed feature.
 *
 * Routes (NOT mounted in server.js by this file — caller must mount):
 *   GET /feed           — лента фотографий с фильтрами
 *   GET /categories     — список типов фото из CRM (кэш 10 мин)
 *   GET /recipients     — {manager,admin} для конкретной АЗС
 *
 * Export: createPhotoFeedRouter({ pool, settingsStore, bitrixClient, getAdminContext })
 */

import express from 'express';

// ---------------------------------------------------------------------------
// Guards — copied verbatim from analyticsRoutes.js pattern
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

const normRemarks = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return s === 'with' || s === 'without' ? s : 'all';
};

// ---------------------------------------------------------------------------
// parseCrmItemId — same helper as reportsRoutes.js
// ---------------------------------------------------------------------------

const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

// ---------------------------------------------------------------------------
// getFieldValue — same helper as reportsRoutes.js (camelCase/original aliases)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createPhotoFeedRouter = ({
  reportsStore,
  settingsStore,
  bitrixClient,
  getAdminContext
}) => {
  if (!reportsStore) throw new Error('reportsStore is required');
  if (!settingsStore) throw new Error('settingsStore is required');
  if (!bitrixClient) throw new Error('bitrixClient is required');

  const router = express.Router();

  // In-memory categories cache: { items, expiresAt }
  let categoriesCache = null;
  const CATEGORIES_TTL_MS = 10 * 60 * 1000; // 10 minutes

  // ---------------------------------------------------------------------------
  // GET /feed
  // ---------------------------------------------------------------------------
  router.get('/feed', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    const limit = normLimit(req.query.limit, 100);
    if (limit > 100) return res.status(400).json({ error: 'limit_exceeded', message: 'limit must be ≤ 100' });

    const dateFrom = normDate(req.query.dateFrom);
    const dateTo = normDate(req.query.dateTo);
    const azsIds = normIds(req.query.azsId);
    const photoCodes = normIds(req.query.photoCode);
    const remarks = normRemarks(req.query.remarks);
    const cursor = String(req.query.cursor || '').trim() || null;

    try {
      const result = await reportsStore.listPhotosFeed({
        dateFrom, dateTo, azsIds, photoCodes, remarks, limit, cursor
      });
      return res.json({ items: result.items, nextCursor: result.nextCursor });
    } catch (err) {
      return res.status(500).json({ error: 'feed_failed', message: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /categories
  // ---------------------------------------------------------------------------
  router.get('/categories', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    // serve from in-memory cache if fresh
    if (categoriesCache && Date.now() < categoriesCache.expiresAt) {
      return res.json({ items: categoriesCache.items });
    }

    try {
      const settings = await settingsStore.read();
      const photoTypeEntityTypeId = Number(settings?.photoType?.entityTypeId || 0);
      if (!photoTypeEntityTypeId) {
        return res.json({ items: [] });
      }

      // Use admin context for CRM reads (mirrors readRequiredPhotos approach)
      let context = req.bitrixContext || {};
      if (typeof getAdminContext === 'function') {
        try {
          const adminCtx = await getAdminContext();
          if (adminCtx) context = adminCtx;
        } catch {
          // best-effort
        }
      }

      const rows = await bitrixClient.listCrmItems({
        entityTypeId: photoTypeEntityTypeId,
        select: ['id', 'ID', 'title', 'TITLE'],
        order: { id: 'ASC' },
        limit: 500,
        useOriginalUfNames: 'N',
        context
      });

      const items = rows
        .map((row) => {
          const id = parseCrmItemId(row?.id ?? row?.ID);
          if (!id) return null;
          const title = String(row?.title ?? row?.TITLE ?? '').trim() || `Фото #${id}`;
          return { code: String(id), title };
        })
        .filter(Boolean);

      categoriesCache = { items, expiresAt: Date.now() + CATEGORIES_TTL_MS };
      return res.json({ items });
    } catch (err) {
      return res.status(500).json({ error: 'categories_failed', message: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /recipients?azsId=
  // ---------------------------------------------------------------------------
  router.get('/recipients', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });

    const azsId = String(req.query.azsId || '').trim();
    const azsItemId = parseCrmItemId(azsId);
    if (!azsItemId) {
      return res.status(400).json({ error: 'invalid_azs_id', message: 'azsId query parameter is required' });
    }

    try {
      const settings = await settingsStore.read();
      const azsEntityTypeId = Number(settings?.azs?.entityTypeId || 0);
      if (!azsEntityTypeId) {
        return res.json({ manager: null, admin: null });
      }

      // Use admin context for CRM reads
      let context = req.bitrixContext || {};
      if (typeof getAdminContext === 'function') {
        try {
          const adminCtx = await getAdminContext();
          if (adminCtx) context = adminCtx;
        } catch {
          // best-effort
        }
      }

      // Fetch AZS card
      let azsItem = null;
      try {
        azsItem = await bitrixClient.getCrmItem({
          entityTypeId: azsEntityTypeId,
          id: azsItemId,
          context
        });
      } catch {
        // fallback to null
      }

      // ----- manager -----
      // From settings.azs.fields.manager (may be absent — then null)
      let manager = null;
      const managerFieldCode = String(settings?.azs?.fields?.manager || '').trim();
      if (managerFieldCode && azsItem) {
        const managerUserId = extractFirstUserId(getFieldValue(azsItem, managerFieldCode));
        if (managerUserId > 0) {
          const managerName = await resolveUserName(bitrixClient, managerUserId, context);
          manager = { id: managerUserId, name: managerName };
        }
      }

      // ----- admin -----
      // Same mechanism as dispatch: settings.azs.fields.admin on the AZS card.
      let admin = null;
      const adminFieldCode = String(settings?.azs?.fields?.admin || '').trim();
      if (adminFieldCode && azsItem) {
        const adminUserId = extractFirstUserId(getFieldValue(azsItem, adminFieldCode));
        if (adminUserId > 0) {
          const adminName = await resolveUserName(bitrixClient, adminUserId, context);
          admin = { id: adminUserId, name: adminName };
        }
      }

      return res.json({ manager, admin });
    } catch (err) {
      return res.status(500).json({ error: 'recipients_failed', message: err.message });
    }
  });

  return router;
};

// ---------------------------------------------------------------------------
// resolveUserName — best-effort user.get via callMethod
// ---------------------------------------------------------------------------

async function resolveUserName(bitrixClient, userId, context = {}) {
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
}

export default createPhotoFeedRouter;
