export const createDispatchScheduler = ({
  dispatchService,
  getCandidates,
  settingsStore = null,
  bitrixClient = null,
  getRuntimeContext = async () => ({}),
  timeoutWatcher = null,
  logger = console,
  enabled = false,
  cronExpression = '* * * * *',
  timeoutCronExpression = '*/5 * * * *',
  nowFn = () => new Date(),
  // Plan-mode deps (all optional, backward-compatible)
  dispatchPlanStore = null,
  generateDailyPlan = null,
  // Enabled by default; set DISPATCH_PLAN_MODE_ENABLED=false to fall back to the
  // legacy "dispatch all at the slot minute" behavior. (`??` so an empty string
  // still means default-on; only an explicit 'false' disables.)
  planModeEnabled = String(process.env.DISPATCH_PLAN_MODE_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  planGenerationCron = process.env.DISPATCH_PLAN_GENERATION_CRON || '1 0 * * *',
  executeBatchLimit = Number(process.env.DISPATCH_EXECUTE_BATCH_LIMIT || 20)
}) => {
  let dispatchTask = null;
  let timeoutTask = null;
  let generationTask = null;
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

  const loadCandidatesFromAzs = async (settings, context = {}) => {
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
      useOriginalUfNames: 'N',
      context
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

  // ---------------------------------------------------------------------------
  // Plan-mode: generate plan for a date (called once/day via cron + boot)
  // ---------------------------------------------------------------------------
  const generatePlanForDate = async (dateKey) => {
    if (!generateDailyPlan || !dispatchPlanStore) {
      logger.warn('dispatchScheduler: generatePlanForDate skipped — missing generateDailyPlan or dispatchPlanStore');
      return;
    }
    const settings = settingsStore ? await settingsStore.read() : {};
    const context = await getRuntimeContext().catch(() => ({}));
    if (!String(context?.authId || '').trim()) {
      logger.warn('dispatchScheduler: generatePlanForDate skipped — missing auth context', { dateKey });
      return;
    }
    const candidates = await (async () => {
      const fileCandidates = await getCandidates();
      return Array.isArray(fileCandidates) && fileCandidates.length > 0
        ? fileCandidates
        : await loadCandidatesFromAzs(settings, context);
    })();

    const summary = await generateDailyPlan({
      planDate: dateKey,
      candidates,
      settings,
      planStore: dispatchPlanStore,
      logger
    });
    logger.info('dispatchScheduler: generatePlanForDate done', summary);
  };

  // ---------------------------------------------------------------------------
  // Plan-mode: execute due plan rows (called every minute tick when flag ON)
  // ---------------------------------------------------------------------------
  const executeDuePlans = async () => {
    if (!dispatchPlanStore) {
      logger.warn('dispatchScheduler: executeDuePlans skipped — no dispatchPlanStore');
      return { due: 0, executed: 0, duplicates: 0, failed: 0 };
    }

    const context = await getRuntimeContext().catch(() => ({}));
    if (!String(context?.authId || '').trim()) {
      logger.warn('dispatchScheduler: executeDuePlans skipped — missing auth context');
      return { due: 0, executed: 0, duplicates: 0, failed: 0 };
    }

    const allDue = await dispatchPlanStore.listDue({ now: nowFn() });
    const due = allDue.length;
    const toProcess = allDue.slice(0, executeBatchLimit);
    const deferred = due - toProcess.length;

    if (deferred > 0) {
      logger.info('dispatchScheduler: executeDuePlans batch limit reached', {
        due,
        processing: toProcess.length,
        deferred
      });
    }

    let executed = 0;
    let duplicates = 0;
    let failed = 0;

    for (const row of toProcess) {
      const candidate = {
        azsId: row.azs_id,
        adminUserId: row.admin_user_id,
        slotDate: row.plan_date,
        slotHHmm: row.base_time,
        scheduledAt: row.execute_at,
        jitterMinutes: row.jitter_minutes
      };

      let result;
      try {
        result = await dispatchService.dispatchBatch({
          candidates: [candidate],
          trigger: 'auto',
          context
        });
      } catch (err) {
        await dispatchPlanStore.markFailed({ id: row.id, error: err.message || String(err) });
        failed += 1;
        continue;
      }

      const item = result.items[0];
      if (item.ok && !item.duplicate) {
        await dispatchPlanStore.markDispatched({ id: row.id, reportItemId: item.reportItemId || null });
        executed += 1;
      } else if (item.duplicate) {
        await dispatchPlanStore.markDispatched({ id: row.id, reportItemId: null });
        duplicates += 1;
      } else {
        await dispatchPlanStore.markFailed({ id: row.id, error: item.error || 'dispatch failed' });
        failed += 1;
      }
    }

    return { due, executed, duplicates, failed };
  };

  // ---------------------------------------------------------------------------
  // runOnce — branches on planModeEnabled flag
  // ---------------------------------------------------------------------------
  const runOnce = async () => {
    // Safety switch: when plan mode is ON, execute due plans instead of the old
    // slot-matching behavior. The old body below is untouched.
    if (planModeEnabled) {
      return executeDuePlans();
    }

    const settings = settingsStore ? await settingsStore.read() : {};
    const context = await getRuntimeContext().catch(() => ({}));
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

    if (!String(context?.authId || '').trim()) {
      logger.warn('dispatchScheduler: auth_context_unavailable', {
        slotKey,
        reason: 'missing_auth_id'
      });
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
      : await loadCandidatesFromAzs(settings, context);

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
    return dispatchService.dispatchBatch({ candidates, trigger: 'auto', context });
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
        logger.info('dispatchScheduler: run finished', result.summary ?? result);
      } catch (error) {
        logger.error('dispatchScheduler: run failed', { error: error.message });
      }
    });

    logger.info('dispatchScheduler: started', { cronExpression });

    if (timeoutWatcher && typeof timeoutWatcher.runOnce === 'function') {
      timeoutTask = cron.schedule(timeoutCronExpression, async () => {
        try {
          const context = await getRuntimeContext().catch(() => ({}));
          const summary = await timeoutWatcher.runOnce({ context });
          logger.info('timeoutScheduler: run finished', summary);
        } catch (error) {
          logger.error('timeoutScheduler: run failed', { error: error.message });
        }
      });
      logger.info('timeoutScheduler: started', { timeoutCronExpression });
    }

    // Plan-mode extras: schema init + daily generation cron + boot bootstrap
    if (planModeEnabled && dispatchPlanStore) {
      try {
        await dispatchPlanStore.ensureSchema();
      } catch (error) {
        logger.error('dispatchScheduler: ensureSchema failed', { error: error.message });
      }

      // Read settings to determine the correct timezone for "today" and the cron.
      // Fall back to DEFAULT_TIMEZONE env var (or 'Europe/Moscow') if not set.
      const planSettings = settingsStore ? await settingsStore.read().catch(() => ({})) : {};
      const planTz = String(planSettings?.timezone || process.env.DEFAULT_TIMEZONE || 'Europe/Moscow').trim();

      generationTask = cron.schedule(planGenerationCron, async () => {
        try {
          // "today" in the configured settings timezone — so '1 0 * * *' means
          // 00:01 in the settings tz, and dateKey is also the settings-tz date.
          const today = getTimeParts(nowFn(), planTz).dateKey;
          await generatePlanForDate(today);
        } catch (error) {
          logger.error('dispatchScheduler: generation cron failed', { error: error.message });
        }
      }, { timezone: planTz });
      logger.info('dispatchScheduler: plan generation cron started', { planGenerationCron, planTz });

      // Boot bootstrap: generate plan for today immediately (idempotent).
      // dateKey uses the settings timezone so it matches what the cron will produce.
      try {
        const today = getTimeParts(nowFn(), planTz).dateKey;
        await generatePlanForDate(today);
      } catch (error) {
        logger.error('dispatchScheduler: boot plan generation failed', { error: error.message });
      }
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
    if (generationTask) {
      generationTask.stop();
      generationTask = null;
    }
  };

  return {
    start,
    stop,
    runOnce
  };
};

export default createDispatchScheduler;
