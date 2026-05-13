import express from 'express';

const normalizeTrigger = (value) => String(value || 'manual').trim().toLowerCase();
const canUseReviewerTools = (req) => (
  Boolean(req.accessContext?.capabilities?.reviewer)
  || Boolean(req.accessContext?.capabilities?.settings)
);

export const createDispatchRouter = ({ dispatchService }) => {
  if (!dispatchService) {
    throw new Error('dispatchService is required');
  }

  const router = express.Router();

  router.post('/dispatch', async (req, res) => {
    if (!canUseReviewerTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Reviewer access is required'
      });
    }

    try {
      const candidates = req.body?.candidates;
      const trigger = normalizeTrigger(req.body?.trigger || 'manual');

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return res.status(400).json({
          error: 'invalid_candidates',
          message: 'POST /api/jobs/dispatch expects non-empty body.candidates array'
        });
      }

      const result = await dispatchService.dispatchBatch({
        candidates,
        trigger,
        context: req.bitrixContext || {}
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error: 'dispatch_failed',
        message: error.message
      });
    }
  });

  router.post('/timeout', async (req, res) => {
    if (!canUseReviewerTools(req)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Reviewer access is required'
      });
    }

    try {
      if (!dispatchService.timeoutWatcher || typeof dispatchService.timeoutWatcher.runOnce !== 'function') {
        return res.status(501).json({
          error: 'timeout_watcher_not_configured',
          message: 'Timeout watcher is not configured'
        });
      }

      const summary = await dispatchService.timeoutWatcher.runOnce({
        limit: Number(req.body?.limit || 200),
        context: req.bitrixContext || {}
      });

      return res.json({ summary });
    } catch (error) {
      return res.status(500).json({
        error: 'timeout_failed',
        message: error.message
      });
    }
  });

  return router;
};

export default createDispatchRouter;
