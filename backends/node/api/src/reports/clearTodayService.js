/**
 * clearTodayService — «Очистить задания на сегодня».
 * Снять несданные отчёты + остановить ещё не отправленные слоты + уведомить
 * сотрудников об отмене. БЕЗ пересоздания плана. Все зависимости инжектируются.
 */
const DEFAULT_CLEAR_MESSAGE = 'Задание на фотоотчёт на сегодня отменено.';

export const clearToday = async ({
  planDate,
  reportsStore,
  dispatchPlanStore,
  notify,
  notifyContext = {},
  notifyMessage = DEFAULT_CLEAR_MESSAGE,
  logger = console,
}) => {
  if (!planDate) throw new Error('clearToday requires planDate');

  const notSubmitted = await reportsStore.listNotSubmittedForDate({ planDate });
  const affected = notSubmitted.length;
  const azsAffected = new Set(notSubmitted.map((r) => String(r.azsId))).size;

  const cancelledReports = await reportsStore.cancelNotSubmittedForDate({ planDate });

  const userIds = [...new Set(notSubmitted.map((r) => Number(r.adminUserId)).filter(Boolean))];
  let notified = 0;
  let notifyFailed = 0;
  for (const userId of userIds) {
    try {
      const result = await notify({ userId, message: notifyMessage, context: notifyContext });
      if (result && result.delivered === false) {
        notifyFailed += 1;
        logger.warn?.('clear_notify_undelivered', { userId, channel: result?.channel, botError: result?.botError });
      } else {
        notified += 1;
      }
    } catch (err) {
      notifyFailed += 1;
      logger.warn?.('clear_notify_failed', { userId, message: err?.message });
    }
  }

  let cancelledSlots = 0;
  if (dispatchPlanStore && typeof dispatchPlanStore.cancelPlannedForDate === 'function') {
    const res = await dispatchPlanStore.cancelPlannedForDate({ planDate });
    cancelledSlots = res?.cancelled ?? 0;
  }

  return { planDate, affected, azsAffected, cancelledReports, cancelledSlots, notified, notifyFailed };
};

export default clearToday;
