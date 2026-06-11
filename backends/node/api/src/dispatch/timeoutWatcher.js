import { updateReportCrmItem } from '../reports/reportCrmSync.js';

const normalizeLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 200;
  }
  return Math.min(Math.floor(n), 500);
};

const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }
  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

export const createTimeoutWatcher = ({
  reportsStore,
  bitrixClient,
  notificationService,
  settingsStore = null,
  reasonStore = null,
  reviewerUserId = Number(process.env.REPORT_REVIEWER_USER_ID || 0),
  nowFn = () => new Date(),
  logger = console
}) => {
  if (!reportsStore || !bitrixClient || !notificationService) {
    throw new Error('reportsStore, bitrixClient and notificationService are required');
  }

  const runOnce = async ({ limit = 200, context = {} } = {}) => {
    const candidates = await reportsStore.listOverdueReports({
      now: nowFn(),
      limit: normalizeLimit(limit)
    });

    let expired = 0;
    let failed = 0;
    let notified = 0;
    let skipped = 0;
    const settings = settingsStore ? await settingsStore.read() : {};
    const azsEntityTypeId = Number(settings?.azs?.entityTypeId || 0);
    const azsTitleCache = new Map();

    const resolveAzsTitle = async (azsId) => {
      const parsedId = parseCrmItemId(azsId);
      const fallback = `АЗС ${parsedId || String(azsId || '').trim() || '?'}`.trim();
      if (!parsedId || !azsEntityTypeId || typeof bitrixClient?.getCrmItem !== 'function') {
        return fallback;
      }
      if (azsTitleCache.has(parsedId)) {
        return azsTitleCache.get(parsedId);
      }
      const promise = (async () => {
        try {
          const item = await bitrixClient.getCrmItem({
            entityTypeId: azsEntityTypeId,
            id: parsedId,
            context
          });
          const title = String(item?.title ?? item?.TITLE ?? '').trim();
          return title || fallback;
        } catch {
          return fallback;
        }
      })();
      azsTitleCache.set(parsedId, promise);
      return promise;
    };

    for (const report of candidates) {
      if (report.status === 'done' || report.status === 'expired') {
        skipped += 1;
        continue;
      }

      try {
        await updateReportCrmItem({
          bitrixClient,
          settings,
          report,
          status: 'expired',
          context
        });

        await reportsStore.setReportStatus({
          reportId: report.id,
          status: 'expired'
        });
        expired += 1;

        // Добор причины при просрочке (best-effort, не ронять цикл)
        if (reasonStore) {
          try {
            const existing = await reasonStore.getByReport(report.id);
            if (!existing) {
              const appCode = String(process.env.BITRIX_APP_CODE || '').trim();
              let reasonLink = null;
              if (process.env.ENABLE_REPORT_DEEP_LINK === 'true' && appCode && report.id) {
                const reasonPath = `/reason/${report.id}`;
                const reasonParams = new URLSearchParams();
                reasonParams.set('params[reportId]', String(report.id));
                reasonParams.set('params[path]', reasonPath);
                reasonLink = `/marketplace/view/${encodeURIComponent(appCode)}/?${reasonParams.toString()}`;
              }
              const reasonKeyboard = reasonLink
                ? [[{ TEXT: '⏰ Указать причину', LINK: reasonLink }]]
                : null;
              const azsTitle = await resolveAzsTitle(report.azsId);
              await notificationService.notify({
                userId: Number(report.adminUserId),
                message: `Отчёт по АЗС ${azsTitle} просрочен. Пожалуйста, укажите причину.`,
                keyboard: reasonKeyboard,
                context,
                fallbackToNotify: true
              });
            }
          } catch (doborError) {
            logger.warn('reason_dobor_failed', {
              reportId: report.id,
              message: doborError.message
            });
          }
        }

        if (reviewerUserId > 0) {
          const azsTitle = await resolveAzsTitle(report.azsId);
          await notificationService.notifyReportExpired({
            userId: reviewerUserId,
            azsId: report.azsId,
            azsTitle,
            deadlineAt: report.deadlineAt,
            timezone: settings.timezone,
            context
          });
          notified += 1;
        }
      } catch (error) {
        failed += 1;
        logger.error('timeoutWatcher failed for report', {
          reportId: report.id,
          azsId: report.azsId,
          slotKey: report.slotKey,
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
