export const createDispatchScheduler = ({
  dispatchService,
  getCandidates,
  logger = console,
  enabled = false,
  cronExpression = '*/5 * * * *'
}) => {
  let task = null;

  const runOnce = async () => {
    const candidates = await getCandidates();
    if (!Array.isArray(candidates) || candidates.length === 0) {
      logger.info('dispatchScheduler: no candidates found, skip run');
      return {
        summary: {
          total: 0,
          created: 0,
          duplicates: 0,
          failed: 0
        },
        items: []
      };
    }
    return dispatchService.dispatchBatch({ candidates, trigger: 'auto' });
  };

  const start = async () => {
    if (!enabled) {
      logger.info('dispatchScheduler: disabled');
      return;
    }

    let cron;
    try {
      cron = await import('node-cron');
    } catch (error) {
      logger.error('dispatchScheduler: node-cron is not installed', { error: error.message });
      return;
    }

    task = cron.schedule(cronExpression, async () => {
      try {
        const result = await runOnce();
        logger.info('dispatchScheduler: run finished', result.summary);
      } catch (error) {
        logger.error('dispatchScheduler: run failed', { error: error.message });
      }
    });

    logger.info('dispatchScheduler: started', { cronExpression });
  };

  const stop = () => {
    if (task) {
      task.stop();
      task = null;
    }
  };

  return {
    start,
    stop,
    runOnce
  };
};

export default createDispatchScheduler;

