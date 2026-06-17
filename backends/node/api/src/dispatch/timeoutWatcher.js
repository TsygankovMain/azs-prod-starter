import { updateReportCrmItem } from '../reports/reportCrmSync.js';
import { NOTIFY_FALLBACK_PREFIX } from '../notifications/notificationService.js';
import { REASON_BUTTON_LABEL_TIMEOUT } from '../notifications/botCommandHandler.js';

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
  dispatchLogStore = null,
  bitrixClient,
  notificationService,
  settingsStore = null,
  reasonStore = null,
  reviewerUserId = Number(process.env.REPORT_REVIEWER_USER_ID || 0),
  botId = Number(process.env.BITRIX_BOT_ID || 0),
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
              // «Указать причину» button: ACTION:SEND sends text as a user message →
              // fires ONIMBOTV2MESSAGEADD → /api/bot/event parses /reason <id>.
              const appCode = String(process.env.BITRIX_APP_CODE || '').trim();
              const resolvedBotId = Number(notificationService?.botId || botId || process.env.BITRIX_BOT_ID || 0);
              const reasonKeyboard = (appCode && report.id)
                ? {
                    BOT_ID: resolvedBotId,
                    BUTTONS: [
                      {
                        TEXT: REASON_BUTTON_LABEL_TIMEOUT,
                        ACTION: 'SEND',
                        // REASON-BTN-TEXT: человеческая фраза вместо «/reason N» —
                        // бот распознаёт нажатие и находит активный отчёт юзера.
                        ACTION_VALUE: REASON_BUTTON_LABEL_TIMEOUT
                      }
                    ]
                  }
                : null;
              const azsTitle = await resolveAzsTitle(report.azsId);
              const doborResult = await notificationService.notify({
                userId: Number(report.adminUserId),
                message: `Отчёт по АЗС ${azsTitle} просрочен. Пожалуйста, укажите причину.`,
                keyboard: reasonKeyboard,
                context,
                fallbackToNotify: true,
                azsId: report.azsId,
                // NOTIF-1: при notify-фоллбэке кнопка теряется — сохраняем путь причины текстом.
                fallbackSuffix: (appCode && report.id)
                  ? `Не успеваете? Ответьте этому боту: /reason ${report.id}`
                  : ''
              });

              // W1-2: annotate report if delivered via notify fallback.
              // Use dispatchLogStore.appendErrorText (canonical); reportsStore
              // duplicate has been removed (I-1 dedup).
              if (doborResult?.channel === 'notify' && doborResult?.botError) {
                const appendFn = dispatchLogStore?.appendErrorText
                  ? dispatchLogStore.appendErrorText.bind(dispatchLogStore)
                  : null;
                if (appendFn) {
                  await appendFn({
                    id: report.id,
                    errorText: `${NOTIFY_FALLBACK_PREFIX}${doborResult.botError}`
                  }).catch(() => {});
                }
              }
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
