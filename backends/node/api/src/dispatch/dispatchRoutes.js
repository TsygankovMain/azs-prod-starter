import express from 'express';

const normalizeTrigger = (value) => String(value || 'manual').trim().toLowerCase();

export const createDispatchRouter = ({ dispatchService }) => {
  if (!dispatchService) {
    throw new Error('dispatchService is required');
  }

  const router = express.Router();

  router.post('/dispatch', async (req, res) => {
    try {
      const candidates = req.body?.candidates;
      const trigger = normalizeTrigger(req.body?.trigger || 'manual');

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return res.status(400).json({
          error: 'invalid_candidates',
          message: 'POST /api/jobs/dispatch expects non-empty body.candidates array'
        });
      }

      const result = await dispatchService.dispatchBatch({ candidates, trigger });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error: 'dispatch_failed',
        message: error.message
      });
    }
  });

  return router;
};

export default createDispatchRouter;

