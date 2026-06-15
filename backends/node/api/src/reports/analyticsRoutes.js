import express from 'express';

const normDate = (v) => { const r = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(r) ? r : ''; };
const normIds = (v) => {
  const src = Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/g);
  return [...new Set(src.map(s => String(s || '').trim()).filter(Boolean))];
};
const canReview = (req) => (
  Boolean(req.accessContext?.capabilities?.reviewer) ||
  Boolean(req.accessContext?.capabilities?.settings)
);
const AUTH_CODES = ['invalid_client', 'wrong_client'];

export const createAnalyticsRouter = ({ analyticsStore, reportsStore, bitrixClient, settingsStore, diskApi, getAdminContext = null, getDiskContext = null }) => {
  if (!analyticsStore) throw new Error('analyticsStore is required');
  const router = express.Router();

  // GET /analytics/rating?dateFrom=&dateTo=&azsId=
  router.get('/analytics/rating', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const rows = await analyticsStore.getRating({
        dateFrom: normDate(req.query.dateFrom),
        dateTo:   normDate(req.query.dateTo),
        azsIds:   normIds(req.query.azsId),
      });
      const settings = await settingsStore.read();
      // BUG-021: one batch call for the page instead of per-row getCrmItem.
      const { batchResolveAzsTitles } = await import('./reportsRoutes.js');
      const pageAzsIds = [...new Set(rows.map(r => r.azsId).filter(Boolean))];
      const titleMap = await batchResolveAzsTitles(pageAzsIds, { bitrixClient, settings, context: req.bitrixContext || {} });
      const items = rows.map(r => ({
        ...r,
        azsTitle: titleMap.get(r.azsId) ?? `АЗС ${r.azsId || '?'}`,
        pct: r.total ? Math.round(r.onTime / r.total * 100) : 0,
      }));
      return res.json({ items });
    } catch (err) {
      return res.status(500).json({ error: 'analytics_rating_failed', message: err.message });
    }
  });

  // GET /analytics/trend?dateFrom=&dateTo=&azsId=
  router.get('/analytics/trend', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const rows = await analyticsStore.getTrend({
        dateFrom: normDate(req.query.dateFrom),
        dateTo:   normDate(req.query.dateTo),
        azsIds:   normIds(req.query.azsId),
      });
      return res.json({ items: rows });
    } catch (err) {
      return res.status(500).json({ error: 'analytics_trend_failed', message: err.message });
    }
  });

  // GET /analytics/day-photos?date=&azsId=
  router.get('/analytics/day-photos', async (req, res) => {
    if (!canReview(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const date = normDate(req.query.date) || (() => {
        const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      })();
      const rows = await analyticsStore.getDayPhotos({
        date,
        azsIds: normIds(req.query.azsId),
      });
      const settings = await settingsStore.read();
      // BUG-021: one batch call for the page instead of per-row getCrmItem.
      const { batchResolveAzsTitles } = await import('./reportsRoutes.js');
      const pageAzsIds = [...new Set(rows.map(r => r.azsId).filter(Boolean))];
      const titleMap = await batchResolveAzsTitles(pageAzsIds, { bitrixClient, settings, context: req.bitrixContext || {} });
      const items = rows.map(r => ({
        ...r,
        azsTitle: titleMap.get(r.azsId) ?? `АЗС ${r.azsId || '?'}`,
      }));
      return res.json({ items, date });
    } catch (err) {
      return res.status(500).json({ error: 'analytics_day_photos_failed', message: err.message });
    }
  });

  // GET /photos/:reportId/:photoCode/preview
  // Proxies binary photo data via Bitrix Disk API using disk_object_id.
  router.get('/photos/:reportId/:photoCode/preview', async (req, res) => {
    // Access: reviewer or reports (AZS admin).
    if (!canReview(req) && !Boolean(req.accessContext?.capabilities?.reports)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const reportId = Number(req.params.reportId);
      if (!Number.isFinite(reportId) || reportId <= 0) {
        return res.status(400).json({ error: 'invalid_report_id' });
      }
      const photoCode = String(req.params.photoCode || '').trim().toLowerCase();
      if (!photoCode) return res.status(400).json({ error: 'invalid_photo_code' });

      const photos = await reportsStore.listPhotos(reportId);
      const photo = photos.find(p => String(p.photoCode || '').toLowerCase() === photoCode);
      if (!photo) return res.status(404).json({ error: 'photo_not_found' });
      if (!photo.diskObjectId) return res.status(404).json({ error: 'disk_object_id_missing' });

      if (!diskApi || typeof diskApi.downloadFileContent !== 'function') {
        return res.status(501).json({ error: 'preview_not_supported', message: 'diskApi.downloadFileContent is not available' });
      }

      // Disk downloads prefer the webhook-first background context (static token
      // in the URL, never expires, needs no client_secret) when available, then
      // admin OAuth, then the request context. User/admin OAuth access tokens
      // expire in ~1h and die when server-side refresh is broken (BUG-020); the
      // webhook context sidesteps refresh entirely. A webhook authorizes via its
      // URL path and carries no authId, so it is selected by isWebhook.
      let diskContext = req.bitrixContext || {};
      if (typeof getAdminContext === 'function') {
        try {
          const adminCtx = await getAdminContext();
          if (adminCtx && String(adminCtx.authId || '').trim()) {
            diskContext = adminCtx;
          }
        } catch { /* best-effort — fall back to request context */ }
      }
      if (typeof getDiskContext === 'function') {
        try {
          const bgCtx = await getDiskContext();
          if (bgCtx && (bgCtx.isWebhook || String(bgCtx.authId || '').trim())) {
            diskContext = bgCtx;
          }
        } catch { /* best-effort — keep prior context */ }
      }
      const { base64, name } = await diskApi.downloadFileContent(photo.diskObjectId, diskContext);
      const buffer = Buffer.from(String(base64 || ''), 'base64');
      const ext = String(name || '').toLowerCase().split('.').pop();
      const contentType = ext === 'png' ? 'image/png'
        : ext === 'webp' ? 'image/webp'
        : (ext === 'heic' || ext === 'heif') ? 'image/heic'
        : 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(buffer);
    } catch (err) {
      // BUG-P2: distinguish auth-broken failures from transient upstream errors.
      // Auth-class signals: invalid_client / wrong_client in err.code or message.
      // These require operator action (re-auth / fix admin context) → 503.
      // Transient/network errors keep 502 so callers don't mislabel blips.
      const errCode = String(err.code || '').toLowerCase();
      const errMsg  = String(err.message || '').toLowerCase();
      const isAuthBroken = AUTH_CODES.some(c => errCode === c || errMsg.includes(c));
      if (isAuthBroken) {
        return res.status(503).json({
          error: 'preview_auth_broken',
          message: 'Photo preview authorization is broken — re-authorize the application or restore the admin context.',
        });
      }
      return res.status(502).json({ error: 'preview_failed', message: err.message });
    }
  });

  return router;
};

export default createAnalyticsRouter;
