import cron from 'node-cron';
import { createThrottledLog } from '../shared/throttledLogger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_WARN_AFTER_DAYS = 23;
const DEFAULT_FORCE_REFRESH_AFTER_DAYS = 29;

const ageInDays = (isoString, now = Date.now()) => {
  if (!isoString) return null;
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (now - parsed) / DAY_MS);
};

/**
 * Pre-emptive OAuth refresh scheduler.
 *
 * Bitrix refresh_token TTL is ~30 days. Without proactive refresh the app
 * silently dies after a month of idle weekends. This watcher walks every
 * stored per-user context once per cron tick and:
 *   - logs a warning when a refresh_token is about to expire (>= 23d old)
 *   - force-triggers a real REST call (app.info) to drive the on-demand
 *     refresh chain inside bitrixRestClient when the token is critical
 *     (>= 29d old). The real call's response error path will hit
 *     isRefreshableAuthError and rotate the token.
 */
export const createTokenRefreshScheduler = ({
  authContextStore,
  bitrixClient,
  enabled = true,
  cronExpression = '0 * * * *', // hourly by default
  warnAfterDays = DEFAULT_WARN_AFTER_DAYS,
  forceRefreshAfterDays = DEFAULT_FORCE_REFRESH_AFTER_DAYS,
  logger = console,
  now = () => Date.now()
} = {}) => {
  if (!authContextStore) throw new Error('tokenRefreshScheduler requires authContextStore');
  if (!bitrixClient) throw new Error('tokenRefreshScheduler requires bitrixClient');

  // Throttle repeated refresh failures to avoid log storms (once per 5 min per key).
  const throttledLog = createThrottledLog({ logger });

  let task = null;

  const runOnce = async () => {
    let entries = [];
    try {
      entries = await authContextStore.listContexts();
    } catch (error) {
      logger.error('tokenRefreshScheduler.listContexts failed', { message: error.message });
      return { checked: 0, warned: 0, refreshed: 0, failed: 0 };
    }

    let warned = 0;
    let refreshed = 0;
    let failed = 0;
    const nowMs = now();

    for (const { key, context } of entries) {
      const age = ageInDays(context?.refreshTokenIssuedAt, nowMs);
      if (age === null) {
        // Unknown issuance — stamp on next /api/getToken or /api/install.
        continue;
      }

      if (age >= forceRefreshAfterDays) {
        logger.warn('tokenRefreshScheduler.force_refresh', {
          key,
          domain: context.domain,
          userId: context.userId,
          ageDays: Math.round(age * 10) / 10
        });
        try {
          // Triggering any REST method is enough — bitrixRestClient will
          // detect refreshable auth errors and rotate transparently. We pick
          // app.info because it is cheap, requires no scope, and exists on
          // every portal.
          await bitrixClient.callMethod('app.info', {}, { key, ...context });
          refreshed += 1;
          logger.info('tokenRefreshScheduler.force_refresh.ok', { key });
        } catch (error) {
          failed += 1;
          throttledLog(
            `tokenRefreshScheduler.force_refresh.failed:${key}`,
            'error',
            'tokenRefreshScheduler.force_refresh.failed',
            { key, message: error.message }
          );
        }
        continue;
      }

      if (age >= warnAfterDays) {
        warned += 1;
        const daysLeft = Math.max(0, Math.round((30 - age) * 10) / 10);
        logger.warn('tokenRefreshScheduler.refresh_token_expiring_soon', {
          key,
          domain: context.domain,
          userId: context.userId,
          ageDays: Math.round(age * 10) / 10,
          daysLeft
        });
      }
    }

    return { checked: entries.length, warned, refreshed, failed };
  };

  const start = () => {
    if (!enabled) {
      logger.info('tokenRefreshScheduler: disabled');
      return false;
    }
    if (task) {
      return true;
    }
    task = cron.schedule(cronExpression, () => {
      runOnce().catch((error) => {
        logger.error('tokenRefreshScheduler.tick failed', { message: error.message });
      });
    });
    logger.info('tokenRefreshScheduler: started', { cronExpression });
    return true;
  };

  const stop = () => {
    if (task) {
      task.stop();
      task = null;
    }
  };

  return { start, stop, runOnce };
};

export default createTokenRefreshScheduler;
