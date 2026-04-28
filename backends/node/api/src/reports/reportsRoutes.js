import express from 'express';

const normalizeDateFilter = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
};

const normalizeLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 200;
  }
  return Math.min(Math.floor(parsed), 500);
};

export const createReportsRouter = ({ reportsStore, dispatchService }) => {
  if (!reportsStore || !dispatchService) {
    throw new Error('reportsStore and dispatchService are required');
  }

  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const items = await reportsStore.list({
        dateFrom: normalizeDateFilter(req.query.dateFrom),
        dateTo: normalizeDateFilter(req.query.dateTo),
        status: String(req.query.status || '').trim(),
        azsId: String(req.query.azsId || '').trim(),
        limit: normalizeLimit(req.query.limit)
      });

      return res.json({
        items,
        total: items.length
      });
    } catch (error) {
      return res.status(500).json({
        error: 'reports_list_failed',
        message: error.message
      });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({
          error: 'invalid_report_id',
          message: 'report id must be a positive number'
        });
      }

      const item = await reportsStore.getById(id);
      if (!item) {
        return res.status(404).json({
          error: 'report_not_found'
        });
      }

      return res.json({ item });
    } catch (error) {
      return res.status(500).json({
        error: 'report_get_failed',
        message: error.message
      });
    }
  });

  router.post('/manual', async (req, res) => {
    try {
      const candidate = req.body?.candidate;
      if (!candidate || typeof candidate !== 'object') {
        return res.status(400).json({
          error: 'invalid_candidate',
          message: 'POST /api/reports/manual expects body.candidate'
        });
      }

      const result = await dispatchService.dispatchBatch({
        candidates: [candidate],
        trigger: 'manual'
      });

      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error: 'manual_report_failed',
        message: error.message
      });
    }
  });

  return router;
};

export default createReportsRouter;

