export const createDispatchScheduler = ({
  dispatchService,
  getCandidates,
  timeoutWatcher = null,
  logger = console,
  enabled = false,
  cronExpression = '*/5 * * * *',
  timeoutCronExpression = '*/5 * * * *'
}) => {
  let dispatchTask = null;
  let timeoutTask = null;

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

    dispatchTask = cron.schedule(cronExpression, async () => {
      try {
        const result = await runOnce();
        logger.info('dispatchScheduler: run finished', result.summary);
      } catch (error) {
        logger.error('dispatchScheduler: run failed', { error: error.message });
      }
    });

    logger.info('dispatchScheduler: started', { cronExpression });

    if (timeoutWatcher && typeof timeoutWatcher.runOnce === 'function') {
      timeoutTask = cron.schedule(timeoutCronExpression, async () => {
        try {
          const summary = await timeoutWatcher.runOnce();
          logger.info('timeoutScheduler: run finished', summary);
        } catch (error) {
          logger.error('timeoutScheduler: run failed', { error: error.message });
        }
      });
      logger.info('timeoutScheduler: started', { timeoutCronExpression });
    }
  };

  const stop = () => {
    if (dispatchTask) {
      dispatchTask.stop();
      dispatchTask = null;
    }
    if (timeoutTask) {
      timeoutTask.stop();
      timeoutTask = null;
    }
  };

  return {
    start,
    stop,
    runOnce
  };
};

export default createDispatchScheduler;
