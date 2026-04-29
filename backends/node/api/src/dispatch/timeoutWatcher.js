import { updateReportCrmItem } from '../reports/reportCrmSync.js';

const normalizeLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 200;
  }
  return Math.min(Math.floor(n), 500);
};

export const createTimeoutWatcher = ({
  reportsStore,
  bitrixClient,
  settingsStore = null,
  reviewerUserId = Number(process.env.REPORT_REVIEWER_USER_ID || 0),
  nowFn = () => new Date(),
  logger = console
}) => {
  if (!reportsStore || !bitrixClient) {
    throw new Error('reportsStore and bitrixClient are required');
  }

  const runOnce = async ({ limit = 200 } = {}) => {
    const candidates = await reportsStore.listOverdueReports({
      now: nowFn(),
      limit: normalizeLimit(limit)
    });

    let expired = 0;
    let failed = 0;
    let notified = 0;
    let skipped = 0;
    const settings = settingsStore ? await settingsStore.read() : {};

    for (const report of candidates) {
      if (report.status === 'done' || report.status === 'expired') {
        skipped += 1;
        continue;
      }

      try {
        await reportsStore.setReportStatus({
          reportId: report.id,
          status: 'expired'
        });

        await updateReportCrmItem({
          bitrixClient,
          settings,
          report,
          status: 'expired'
        });
        expired += 1;

        if (reviewerUserId > 0) {
          await bitrixClient.notifyUser({
            userId: reviewerUserId,
            message: `Отчёт АЗС ${report.azsId} просрочен (slot ${report.slotKey}).`
          });
          notified += 1;
        }
      } catch (error) {
        failed += 1;
        logger.error('timeoutWatcher failed for report', {
          reportId: report.id,
          error: error.message
        });
      }
    }

    return {
      total: candidates.length,
      expired,
      failed,
      notified,
      skipped
    };
  };

  return {
    runOnce
  };
};

export default createTimeoutWatcher;
