import express from 'express';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { sanitizeBundle, generateDiagCode } from './sanitizeBundle.js';

export const DIAG_JSON_LIMIT = '512kb';
export const DIAG_ECHO_LIMIT = '1mb';

/**
 * diagRoutes — приём диагностических бандлов и активные пробы.
 *
 * /ping и /echo намеренно не делают ничего тяжёлого: их задача — измерить
 * сеть оператора, а не нашу БД. Поэтому они не обращаются к стору и должны
 * монтироваться без attachAccessContext (см. Task 6).
 */
export const createDiagRouter = ({ store, randomBytes = nodeRandomBytes, logger = console, serverSelfCheck = null }) => {
  const router = express.Router();

  router.get('/ping', (_req, res) => {
    res.json({ t: Date.now() });
  });

  router.post('/echo', express.raw({ type: '*/*', limit: DIAG_ECHO_LIMIT }), (req, res) => {
    const startedAt = Date.now();
    const bytes = Buffer.isBuffer(req.body) ? req.body.length : 0;
    res.json({ bytes, serverMs: Date.now() - startedAt });
  });

  router.post('/report', express.json({ limit: DIAG_JSON_LIMIT }), async (req, res) => {
    const result = sanitizeBundle(req.body);
    if (!result.ok) {
      logger.warn('diag_report_rejected', { reason: result.error });
      return res.status(400).json({ error: result.error });
    }

    const { bundle, sizeBytes } = result;
    const code = generateDiagCode(randomBytes(6));

    // Серверный срез — best-effort и никогда не роняет приём бандла: клиентская
    // половина ценна сама по себе, терять её из-за зависшего Диска нельзя.
    // Реализация — Task 11; до неё serverSelfCheck === null.
    let serverSlice = null;
    if (serverSelfCheck) {
      try {
        serverSlice = await serverSelfCheck.run();
      } catch (error) {
        logger.warn('diag_server_slice_failed', { code, message: error.message });
      }
    }

    try {
      const row = await store.insert({
        code,
        diagSessionId: bundle.diagSessionId || null,
        userId: Number(req.user?.user_id || req.user?.id || 0) || null,
        azsId: bundle.user?.azsId || null,
        reportId: bundle.user?.reportId || null,
        trigger: bundle.trigger,
        sizeBytes,
        bundle,
        serverSlice
      });
      logger.info('diag_report_stored', {
        code, sizeBytes, trigger: bundle.trigger, azsId: bundle.user?.azsId || null
      });
      return res.json({ diagId: row?.id ?? null, code });
    } catch (error) {
      logger.error('diag_report_failed', { code, message: error.message });
      return res.status(500).json({ error: 'diag_report_failed', message: error.message });
    }
  });

  router.get('/reports', async (req, res) => {
    try {
      const items = await store.list({
        azsId: String(req.query.azsId || ''),
        dateFrom: String(req.query.dateFrom || ''),
        dateTo: String(req.query.dateTo || ''),
        limit: Number(req.query.limit || 50)
      });
      return res.json({ items });
    } catch (error) {
      return res.status(500).json({ error: 'diag_list_failed', message: error.message });
    }
  });

  router.get('/reports/:code', async (req, res) => {
    try {
      const row = await store.getByCode(req.params.code);
      if (!row) return res.status(404).json({ error: 'diag_report_not_found' });
      return res.json({ item: row });
    } catch (error) {
      return res.status(500).json({ error: 'diag_get_failed', message: error.message });
    }
  });

  return router;
};

export default createDiagRouter;
