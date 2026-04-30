export const createDispatchScheduler = ({
  dispatchService,
  getCandidates,
  settingsStore = null,
  bitrixClient = null,
  timeoutWatcher = null,
  logger = console,
  enabled = false,
  cronExpression = '* * * * *',
  timeoutCronExpression = '*/5 * * * *',
  nowFn = () => new Date()
}) => {
  let dispatchTask = null;
  let timeoutTask = null;
  let lastSlotKey = '';

  const parsePositiveInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const parseScheduleTimes = (value) => {
    const source = Array.isArray(value)
      ? value
      : String(value || '').split(/[,\n;]+/g);

    const slots = [...new Set(
      source
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .map((item) => {
          const time = item.includes(':') ? item : `${item.slice(0, 2)}:${item.slice(2, 4)}`;
          const match = time.match(/^(\d{1,2}):(\d{2})$/);
          if (!match) {
            return '';
          }
          const hours = Number(match[1]);
          const minutes = Number(match[2]);
          if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
            return '';
          }
          return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
        })
        .filter(Boolean)
    )];

    return slots.sort();
  };

  const getTimeParts = (dateValue, timezone) => {
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      });
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(dateValue))
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, part.value])
      );
      return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        hhmm: `${parts.hour}${parts.minute}`
      };
    } catch {
      const utc = new Date(dateValue);
      const pad = (n) => String(n).padStart(2, '0');
      return {
        dateKey: `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`,
        hhmm: `${pad(utc.getUTCHours())}${pad(utc.getUTCMinutes())}`
      };
    }
  };

  const getFieldValue = (item, fieldCode) => {
    if (!item || !fieldCode) {
      return undefined;
    }
    const normalizedFieldCode = String(fieldCode || '').trim();
    const aliases = [
      normalizedFieldCode,
      normalizedFieldCode.toLowerCase(),
      normalizedFieldCode.toUpperCase()
    ];
    const camelUfMatch = normalizedFieldCode.match(/^ufCrm(\d+)_(\d+)$/i);
    if (camelUfMatch) {
      aliases.push(`UF_CRM_${camelUfMatch[1]}_${camelUfMatch[2]}`);
      aliases.push(`ufCrm${camelUfMatch[1]}_${camelUfMatch[2]}`);
    }
    for (const alias of aliases) {
      if (alias && alias in item) {
        return item[alias];
      }
    }
    return undefined;
  };

  const parseUserId = (value) => {
    if (Array.isArray(value)) {
      for (const row of value) {
        const next = parseUserId(row);
        if (next > 0) {
          return next;
        }
      }
      return 0;
    }
    if (value && typeof value === 'object') {
      return parseUserId(value.id ?? value.ID ?? value.value ?? value.VALUE);
    }
    return parsePositiveInt(value);
  };

  const isDisabled = (value) => {
    if (Array.isArray(value)) {
      return value.some((row) => isDisabled(row));
    }
    if (value && typeof value === 'object') {
      return isDisabled(value.value ?? value.VALUE ?? value.id ?? value.ID);
    }
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === 'n' || raw === '0' || raw === 'false' || raw === 'нет';
  };

  const expandFieldAliases = (fieldCode) => {
    const code = String(fieldCode || '').trim();
    if (!code) {
      return [];
    }
    const aliases = new Set([code, code.toLowerCase(), code.toUpperCase()]);
    const camelUfMatch = code.match(/^ufCrm(\d+)_(\d+)$/i);
    if (camelUfMatch) {
      aliases.add(`UF_CRM_${camelUfMatch[1]}_${camelUfMatch[2]}`);
      aliases.add(`ufCrm${camelUfMatch[1]}_${camelUfMatch[2]}`);
    }
    return [...aliases];
  };

  const loadCandidatesFromAzs = async (settings) => {
    const azsEntityTypeId = Number(settings?.azs?.entityTypeId || 0);
    const adminField = String(settings?.azs?.fields?.admin || '').trim();
    const enabledField = String(settings?.azs?.fields?.enabled || '').trim();
    if (!azsEntityTypeId || !adminField || typeof bitrixClient?.listCrmItems !== 'function') {
      return [];
    }

    const select = [...new Set([
      'id',
      'ID',
      ...expandFieldAliases(adminField),
      ...(enabledField ? expandFieldAliases(enabledField) : [])
    ])];
    const rows = await bitrixClient.listCrmItems({
      entityTypeId: azsEntityTypeId,
      select,
      limit: 1000,
      useOriginalUfNames: 'N'
    });

    logger.info('dispatchScheduler: loaded AZS candidates source', {
      azsEntityTypeId,
      rows: rows.length,
      adminField,
      enabledField,
      select
    });

    return rows
      .filter((item) => {
        if (!enabledField) {
          return true;
        }
        return !isDisabled(getFieldValue(item, enabledField));
      })
      .map((item) => ({
        azsId: String(parsePositiveInt(item?.id ?? item?.ID) || item?.id || item?.ID || '').trim(),
        adminUserId: parseUserId(getFieldValue(item, adminField))
      }))
      .filter((item) => item.azsId && item.adminUserId > 0);
  };

  const runOnce = async () => {
    const settings = settingsStore ? await settingsStore.read() : {};
    const timezone = String(settings?.timezone || process.env.DEFAULT_TIMEZONE || 'Europe/Moscow').trim();
    const scheduleTimes = parseScheduleTimes(settings?.report?.dispatchTimes);
    if (!scheduleTimes.length) {
      logger.info('dispatchScheduler: report.dispatchTimes is empty, skip run');
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

    const timeParts = getTimeParts(nowFn(), timezone);
    if (!scheduleTimes.includes(timeParts.hhmm)) {
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

    const slotKey = `${timeParts.dateKey}:${timeParts.hhmm}`;
    if (slotKey === lastSlotKey) {
      logger.info('dispatchScheduler: slot already processed, skip duplicate tick', { slotKey });
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

    const fileCandidates = await getCandidates();
    const autoCandidates = Array.isArray(fileCandidates) && fileCandidates.length > 0
      ? fileCandidates
      : await loadCandidatesFromAzs(settings);

    logger.info('dispatchScheduler: slot matched', {
      slotKey,
      scheduleTimes,
      source: Array.isArray(fileCandidates) && fileCandidates.length > 0 ? 'file' : 'azs',
      candidatesCount: autoCandidates.length
    });

    const candidates = autoCandidates.map((item) => ({
      ...item,
      slotDate: timeParts.dateKey,
      slotHHmm: timeParts.hhmm
    }));
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
    lastSlotKey = slotKey;
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
