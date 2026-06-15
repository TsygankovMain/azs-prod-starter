import { NOTIFY_FALLBACK_PREFIX } from '../notifications/notificationService.js';
import { buildZonedDatetime } from './dispatchPlanGenerator.js';

const MINUTES_TO_MS = 60 * 1000;

const pad2 = (value) => String(value).padStart(2, '0');

const normalizeSlot = (value) => String(value || '')
  .replace(/[^0-9]/g, '')
  .slice(0, 4)
  .padStart(4, '0');

export const formatDateKeyUtc = (date) => {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) {
    throw new Error('Invalid date for formatDateKeyUtc');
  }
  return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
};

export const buildSlotKey = ({ slotDate, slotHHmm }) => `${slotDate}:${normalizeSlot(slotHHmm)}`;

const buildReserveSlotKey = ({ slotKey, trigger = 'auto' }) => {
  if (String(trigger || '').toLowerCase() === 'manual') {
    return `manual:${slotKey}`;
  }
  return slotKey;
};

export const pickJitterMinutes = (maxAbsMinutes = 0, rng = Math.random) => {
  const bound = Number(maxAbsMinutes);
  if (!Number.isFinite(bound) || bound <= 0) {
    return 0;
  }
  const min = -Math.floor(bound);
  const max = Math.floor(bound);
  const randomValue = Math.min(Math.max(Number(rng()) || 0, 0), 0.9999999999999999);
  return Math.floor(randomValue * (max - min + 1)) + min;
};

const parseSlotDateTimeUtc = ({ slotDate, slotHHmm }) => {
  const safeSlot = normalizeSlot(slotHHmm);
  const hours = Number(safeSlot.slice(0, 2));
  const minutes = Number(safeSlot.slice(2, 4));
  const parsed = new Date(`${slotDate}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid slotDate, expected YYYY-MM-DD');
  }

  parsed.setUTCHours(hours, minutes, 0, 0);
  return parsed;
};

const addMinutes = (dateValue, minutes) => new Date(new Date(dateValue).getTime() + (Number(minutes) * MINUTES_TO_MS));

const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }
  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const resolveAzsTitle = async ({ bitrixClient, settings, azsId, context = {} }) => {
  const parsedId = parseCrmItemId(azsId);
  const fallback = `АЗС ${parsedId || String(azsId || '').trim() || '?'}`.trim();
  const entityTypeId = Number(settings?.azs?.entityTypeId || 0);
  if (!parsedId || !entityTypeId || typeof bitrixClient?.getCrmItem !== 'function') {
    return fallback;
  }

  try {
    const item = await bitrixClient.getCrmItem({ entityTypeId, id: parsedId, context });
    const title = String(item?.title ?? item?.TITLE ?? '').trim();
    return title || fallback;
  } catch {
    return fallback;
  }
};

const buildReportFields = ({ settings, candidate, slotHHmm, scheduledAt, deadlineAt, trigger }) => {
  const fieldsMap = settings.report?.fields || {};
  const mappedFields = {
    title: `Фото-отчёт АЗС ${candidate.azsId} / ${slotHHmm}`,
    assignedById: Number(candidate.adminUserId),
    begindate: scheduledAt.toISOString(),
    closedate: deadlineAt.toISOString(),
    opened: 'N'
  };
  const setField = (fieldCode, value) => {
    if (!fieldCode) {
      return;
    }
    mappedFields[fieldCode] = value;
  };

  setField(fieldsMap.azs, candidate.azsId);
  setField(fieldsMap.trigger, trigger);

  if (settings.report?.stages?.new) {
    mappedFields.stageId = settings.report.stages.new;
  }

  return mappedFields;
};

export const createDispatchService = ({
  dispatchLogStore,
  settingsStore,
  bitrixClient,
  notificationService,
  timeoutWatcher = null,
  botId = Number(process.env.BITRIX_BOT_ID || 0),
  nowFn = () => new Date(),
  rng = Math.random,
  logger = console
}) => {
  if (!dispatchLogStore || !settingsStore || !bitrixClient || !notificationService) {
    throw new Error('dispatchLogStore, settingsStore, bitrixClient and notificationService are required');
  }

  const dispatchCandidate = async ({ candidate, settings, trigger = 'auto', context = {} }) => {
    if (!candidate?.azsId) {
      throw new Error('candidate.azsId is required');
    }
    if (!candidate?.adminUserId) {
      throw new Error('candidate.adminUserId is required');
    }

    const timeoutMinutes = Number(settings.report?.timeoutMinutes || 60);
    const jitterLimit = Number(settings.report?.dispatchJitterMinutes || 0);
    const nowValue = new Date(nowFn());
    const plannedDate = candidate.slotDate || formatDateKeyUtc(nowValue);
    const slotHHmm = normalizeSlot(candidate.slotHHmm || `${pad2(nowValue.getUTCHours())}${pad2(nowValue.getUTCMinutes())}`);
    const slotKey = buildSlotKey({ slotDate: plannedDate, slotHHmm });
    const reserveSlotKey = buildReserveSlotKey({ slotKey, trigger });

    // Compute the timezone-correct slot instant so reserve() stores an accurate
    // scheduled_at.  settings.timezone is the portal timezone (e.g. 'Europe/Moscow');
    // without it parseSlotDateTimeUtc would treat HHmm as UTC, causing stale-detect
    // to fire 3 h late on UTC+3 portals.  If buildZonedDatetime throws (bad date)
    // we fall back to null; reserve() will then use parseSlotDateTimeUtc as before.
    let reserveScheduledAt = null;
    try {
      const tz = String(settings?.timezone || '').trim();
      reserveScheduledAt = buildZonedDatetime(plannedDate, slotHHmm, tz);
    } catch {
      // keep null — reserve() falls back to parseSlotDateTimeUtc(slotKey)
    }

    const reserve = await dispatchLogStore.reserve({
      slotKey: reserveSlotKey,
      azsId: String(candidate.azsId),
      adminUserId: Number(candidate.adminUserId),
      status: 'reserved',
      scheduledAt: reserveScheduledAt
    });

    if (!reserve.reserved) {
      return {
        ok: true,
        duplicate: true,
        slotKey,
        azsId: candidate.azsId,
        duplicateReason: String(trigger || '').toLowerCase() === 'manual'
          ? 'manual_slot_exists'
          : 'auto_slot_exists'
      };
    }

    let reportItemId = null;
    try {
      // Only a Date or a non-empty string counts as pre-computed. Guarding on
      // typeof avoids falsy-but-valid coercions (e.g. new Date(0)→epoch, new
      // Date(false)→epoch) silently dispatching to 1970.
      const precomputedRaw = candidate.scheduledAt;
      const hasPrecomputed = precomputedRaw instanceof Date
        || (typeof precomputedRaw === 'string' && precomputedRaw.trim() !== '');
      let jitterMinutes;
      let scheduledAt;
      if (hasPrecomputed) {
        const parsed = new Date(precomputedRaw);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error('candidate.scheduledAt is invalid');
        }
        scheduledAt = parsed;
        jitterMinutes = Number.isFinite(Number(candidate.jitterMinutes)) ? Number(candidate.jitterMinutes) : 0;
      } else {
        jitterMinutes = pickJitterMinutes(jitterLimit, rng);
        const tz = String(settings?.timezone || '').trim();
        const plannedAt = buildZonedDatetime(plannedDate, slotHHmm, tz);
        scheduledAt = addMinutes(plannedAt, jitterMinutes);
      }
      // S8-БЛОКЕР #2: deadlineOverride (AC-13, режим B).
      // Если кандидат несёт candidate.deadlineAt (deadline_at из плановой строки
      // dispatch_plan — конец последнего окна эскалации режима B), используем его
      // ВМЕСТО формулы BUG-024. Режим A и не-профильные (deadline_at=null) →
      // прежняя формула (без регресса).
      let deadlineAt;
      const overrideRaw = candidate.deadlineAt;
      const hasOverride = overrideRaw instanceof Date
        || (typeof overrideRaw === 'string' && String(overrideRaw).trim() !== '');
      if (hasOverride) {
        const parsed = new Date(overrideRaw);
        if (!Number.isNaN(parsed.getTime())) {
          deadlineAt = parsed;
        }
      }
      if (!deadlineAt) {
        // BUG-024: дедлайн = max(плановый, now) + timeout.
        // Если воркер забрал слот с опозданием, AZS всегда получает полный window
        // с момента ФАКТИЧЕСКОЙ отправки. Используем max чтобы не укорачивать
        // future-дедлайны для слотов, которые ещё не наступили.
        const effectiveBase = new Date(Math.max(scheduledAt.getTime(), nowValue.getTime()));
        deadlineAt = addMinutes(effectiveBase, timeoutMinutes);
      }
      const fields = buildReportFields({
        settings,
        candidate,
        slotHHmm,
        scheduledAt,
        deadlineAt,
        trigger
      });

      const reportResult = await bitrixClient.createReportItem({
        entityTypeId: Number(settings.report?.entityTypeId || 0),
        fields,
        context
      });
      reportItemId = reportResult.reportItemId;

      await dispatchLogStore.markDone({
        id: reserve.id,
        reportItemId,
        jitterMinutes,
        scheduledAt,
        deadlineAt
      });

      try {
        const azsTitle = await resolveAzsTitle({
          bitrixClient,
          settings,
          azsId: candidate.azsId,
          context
        });

        let dispatchKeyboard = null;
        try {
          // «Указать причину» button: ACTION:SEND makes the press send the text as a
          // message from the user → fires ONIMBOTV2MESSAGEADD → /api/bot/event parses it.
          // No command registration needed. BITRIX_APP_CODE guard kept: without it we
          // have no reportId context either.
          const appCode = String(process.env.BITRIX_APP_CODE || '').trim();
          // Encode the INTERNAL report id (reserve.id = dispatch_log.id), NOT the
          // CRM item id — the bot reason side-effects look up the report via
          // reportsStore.getById/setReportStatus, which key on dispatch_log.id.
          // Using reportItemId here made onBotReasonCaptured find no report → no
          // CRM stage change, no forward, no local status update.
          const reasonReportId = reserve.id;
          if (appCode && reasonReportId) {
            const resolvedBotId = Number(notificationService?.botId || botId || process.env.BITRIX_BOT_ID || 0);
            const buttons = [
              {
                TEXT: 'Не успеваю — указать причину',
                ACTION: 'SEND',
                ACTION_VALUE: `/reason ${reasonReportId}`
              }
            ];
            dispatchKeyboard = { BOT_ID: resolvedBotId, BUTTONS: buttons };
          }
        } catch {
          // Defensive: skip keyboard if building fails
        }

        const notifyResult = await notificationService.notifyDispatch({
          userId: Number(candidate.adminUserId),
          azsId: candidate.azsId,
          azsTitle,
          deadlineAt,
          timezone: settings.timezone,
          keyboard: dispatchKeyboard,
          context
        });

        // W1-2: if delivered via notify fallback, annotate the dispatch log error_text
        if (notifyResult?.channel === 'notify' && notifyResult?.botError) {
          await dispatchLogStore.appendErrorText?.({
            id: reserve.id,
            errorText: `${NOTIFY_FALLBACK_PREFIX}${notifyResult.botError}`
          });
        }
      } catch (notifyError) {
        logger.warn('dispatchCandidate notification failed', {
          slotKey,
          azsId: candidate.azsId,
          reportId: reserve.id,
          error: notifyError?.message || String(notifyError)
        });
      }

      return {
        ok: true,
        duplicate: false,
        slotKey,
        azsId: candidate.azsId,
        reportItemId,
        jitterMinutes
      };
    } catch (error) {
      await dispatchLogStore.markFailed({
        id: reserve.id,
        errorText: error.message
      });
      logger.error('dispatchCandidate failed', {
        slotKey,
        azsId: candidate.azsId,
        error: error.message
      });
      return {
        ok: false,
        duplicate: false,
        slotKey,
        azsId: candidate.azsId,
        error: error.message
      };
    }
  };

  const dispatchBatch = async ({ candidates, trigger = 'auto', context = {} } = {}) => {
    if (!Array.isArray(candidates)) {
      throw new Error('candidates must be an array');
    }

    const settings = await settingsStore.read();
    const items = [];
    for (const candidate of candidates) {
      items.push(await dispatchCandidate({ candidate, settings, trigger, context }));
    }

    const summary = {
      total: items.length,
      created: items.filter((item) => item.ok && !item.duplicate).length,
      duplicates: items.filter((item) => item.duplicate).length,
      failed: items.filter((item) => !item.ok).length
    };

    return { summary, items };
  };

  return {
    dispatchBatch,
    dispatchCandidate,
    timeoutWatcher
  };
};

export default createDispatchService;
