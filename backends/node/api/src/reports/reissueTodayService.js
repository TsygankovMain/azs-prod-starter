/**
 * reissueTodayService — оркестрация «Перевыпустить задания на сегодня».
 * Чистая логика без HTTP/Bitrix: снять несданные → уведомить → пересоздать.
 * Все побочные зависимости (store, notify, generateDailyPlan) инжектируются.
 */

const DEFAULT_CANCEL_MESSAGE =
  'Задание на фотоотчёт на сегодня отменено — расписание изменилось. Скоро придёт обновлённое задание.';

export const reissueToday = async ({
  planDate,
  dryRun = false,
  reportsStore,
  dispatchPlanStore,
  settings,
  candidates = [],
  notify,
  notifyContext = {},
  notifyMessage = DEFAULT_CANCEL_MESSAGE,
  generateDailyPlan,
  logger = console,
}) => {
  if (!planDate) throw new Error('reissueToday requires planDate');

  const notSubmitted = await reportsStore.listNotSubmittedForDate({ planDate });
  const submittedAzs = new Set((await reportsStore.listSubmittedAzsForDate({ planDate })).map(String));

  const affected = notSubmitted.length;
  const azsAffected = new Set(notSubmitted.map((r) => String(r.azsId))).size;
  const submittedKept = submittedAzs.size;

  const regenCandidates = candidates.filter((c) => !submittedAzs.has(String(c.azsId)));
  const skippedSubmittedAzs = candidates.length - regenCandidates.length;

  if (dryRun) {
    return { dryRun: true, planDate, affected, azsAffected, submittedKept, skippedSubmittedAzs, willRegenerate: regenCandidates.length };
  }

  const cancelled = await reportsStore.cancelNotSubmittedForDate({ planDate });

  const userIds = [...new Set(notSubmitted.map((r) => Number(r.adminUserId)).filter(Boolean))];
  let notified = 0;
  let notifyFailed = 0;
  for (const userId of userIds) {
    try {
      await notify({ userId, message: notifyMessage, context: notifyContext });
      notified += 1;
    } catch (err) {
      notifyFailed += 1;
      logger.warn?.('reissue_notify_failed', { userId, message: err?.message });
    }
  }

  let regenerated = 0;
  if (regenCandidates.length > 0) {
    const summary = await generateDailyPlan({
      planDate, candidates: regenCandidates, settings, planStore: dispatchPlanStore, regenerate: true, logger,
    });
    regenerated = Number(summary?.planned ?? 0);
  }

  return { dryRun: false, planDate, affected, azsAffected, submittedKept, cancelled, notified, notifyFailed, regenerated, skippedSubmittedAzs };
};

export default reissueToday;
