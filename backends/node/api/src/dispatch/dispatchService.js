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

const buildReportFields = ({ settings, candidate, slotHHmm, scheduledAt, deadlineAt, trigger }) => {
  const fieldsMap = settings.report?.fields || {};
  const mappedFields = {};
  const setField = (fieldCode, value) => {
    if (!fieldCode) {
      return;
    }
    mappedFields[fieldCode] = value;
  };

  setField(fieldsMap.azs, candidate.azsId);
  setField(fieldsMap.admin, candidate.adminUserId);
  setField(fieldsMap.slotTime, slotHHmm);
  setField(fieldsMap.scheduledAt, scheduledAt.toISOString());
  setField(fieldsMap.deadlineAt, deadlineAt.toISOString());
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
  nowFn = () => new Date(),
  rng = Math.random,
  logger = console
}) => {
  if (!dispatchLogStore || !settingsStore || !bitrixClient) {
    throw new Error('dispatchLogStore, settingsStore and bitrixClient are required');
  }

  const dispatchCandidate = async ({ candidate, settings, trigger = 'auto' }) => {
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
    const jitterMinutes = pickJitterMinutes(jitterLimit, rng);

    const reserve = await dispatchLogStore.reserve({
      slotKey,
      azsId: String(candidate.azsId),
      adminUserId: Number(candidate.adminUserId),
      status: 'reserved'
    });

    if (!reserve.reserved) {
      return {
        ok: true,
        duplicate: true,
        slotKey,
        azsId: candidate.azsId
      };
    }

    let reportItemId = null;
    try {
      const plannedAt = parseSlotDateTimeUtc({ slotDate: plannedDate, slotHHmm });
      const scheduledAt = addMinutes(plannedAt, jitterMinutes);
      const deadlineAt = addMinutes(scheduledAt, timeoutMinutes);
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
        fields
      });
      reportItemId = reportResult.reportItemId;

      await bitrixClient.notifyUser({
        userId: Number(candidate.adminUserId),
        message: `Фото-отчёт АЗС: слот ${slotHHmm}, дедлайн ${deadlineAt.toISOString()}`
      });

      await dispatchLogStore.markDone({
        id: reserve.id,
        reportItemId,
        jitterMinutes,
        scheduledAt,
        deadlineAt
      });

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

  const dispatchBatch = async ({ candidates, trigger = 'auto' } = {}) => {
    if (!Array.isArray(candidates)) {
      throw new Error('candidates must be an array');
    }

    const settings = await settingsStore.read();
    const items = [];
    for (const candidate of candidates) {
      items.push(await dispatchCandidate({ candidate, settings, trigger }));
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
    dispatchCandidate
  };
};

export default createDispatchService;
