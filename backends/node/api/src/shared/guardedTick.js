/**
 * Creates a cron-tick wrapper that prevents concurrent overlapping runs.
 *
 * If a tick is already running when the next one fires, the new tick returns
 * {skipped: true} immediately and calls onSkip() for logging — instead of
 * starting a second concurrent execution that could amplify Bitrix rate-limit
 * pressure (positive-feedback / "degradation spiral").
 *
 * Usage:
 *   const tick = createGuardedTick({ runOnce, onSkip });
 *   cronSchedule(expression, tick);
 *
 * @param {{ runOnce: () => Promise<any>, onSkip?: () => void }} options
 * @returns {() => Promise<{skipped: true} | any>}
 */
export function createGuardedTick({ runOnce, onSkip = () => {} }) {
  let running = false;
  return async function tick() {
    if (running) {
      onSkip();
      return { skipped: true };
    }
    running = true;
    try {
      return await runOnce();
    } finally {
      running = false;
    }
  };
}
