/**
 * photoFeedRoutes — Express router for the photo-feed feature.
 *
 * Routes (NOT mounted in server.js by this file — caller must mount):
 *   GET /feed           — лента фотографий с фильтрами
 *   GET /categories     — список типов фото из CRM (кэш 10 мин)
 *   GET /recipients     — {manager,admin} для конкретной АЗС
 *
 * Export: createPhotoFeedRouter({ reportsStore, settingsStore, bitrixClient, getAdminContext })
 */

import express from 'express';
import { resolveAzsRecipients } from './azsRecipients.js';
import { createAzsTitleResolver } from './reportsRoutes.js';

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
// parseCrmItemId — needed for categories id parsing
// ---------------------------------------------------------------------------

const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

// ---------------------------------------------------------------------------
// cursor validation helper
// ---------------------------------------------------------------------------

const isValidCursor = (cursor) => {
  if (!cursor) return true; // null/empty is always valid (no cursor)
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    return Boolean(raw && typeof raw === 'object');
  } catch {
    return false;
  }
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

    const dateFrom = normDate(req.query.dateFrom);
    const dateTo = normDate(req.query.dateTo);
    const azsIds = normIds(req.query.azsId);
    const photoCodes = normIds(req.query.photoCode);
    const remarks = normRemarks(req.query.remarks);
    const cursor = String(req.query.cursor || '').trim() || null;

    // Validate cursor before hitting the store
    if (cursor && !isValidCursor(cursor)) {
      return res.status(400).json({ error: 'invalid_cursor' });
    }

    try {
      const result = await reportsStore.listPhotosFeed({
        dateFrom, dateTo, azsIds, photoCodes, remarks, limit, cursor
      });

      // Resolve azsTitle for all unique azsIds on this page
      const pageAzsIds = [...new Set(result.items.map((item) => item.azsId).filter(Boolean))];
      let items = result.items;
      if (pageAzsIds.length > 0) {
        const settings = await settingsStore.read();
        const resolveAzsTitle = createAzsTitleResolver({
          bitrixClient,
          settings,
          context: req.bitrixContext || {}
        });
        const titleMap = new Map();
        await Promise.all(pageAzsIds.map(async (id) => {
          const title = await resolveAzsTitle(id);
          titleMap.set(id, title || null);
        }));
        items = result.items.map((item) => ({
          ...item,
          azsTitle: titleMap.get(item.azsId) ?? item.azsTitle
        }));
      }

      return res.json({ items, nextCursor: result.nextCursor });
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
  });

  return router;
};

export default createPhotoFeedRouter;
