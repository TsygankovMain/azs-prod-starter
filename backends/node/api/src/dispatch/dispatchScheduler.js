import { createGuardedTick } from '../shared/guardedTick.js';
import { createThrottledLog } from '../shared/throttledLogger.js';

/**
 * Stale-planned slot threshold in minutes (default 30).
 * Slots whose status is still 'reserved' more than this many minutes after
 * they were created are considered stale and get finished (executed or failed).
 * Override with DISPATCH_STALE_PLANNED_MINUTES env variable.
 */
const STALE_PLANNED_MINUTES_DEFAULT = 30;

/**
 * assertDispatchAvailable — guard helper for callers that need a live auth/dispatch
 * context before creating a manual dispatch slot.
 *
 * Throws a typed error (code 'BOT_UNAVAILABLE', statusCode 503) when no usable
 * context is available. Callers in the service layer should invoke this before
 * initiating a manual dispatch. If the entry point is in server.js (which is
 * owned by another agent), wire the helper call in the service layer instead of
 * the route handler — see the comment in W1-3 spec.
 *
 * @param {{ getRuntimeContext: () => Promise<object>, getBackgroundContext?: () => Promise<object> }} opts
 * @throws {{ message: string, code: 'BOT_UNAVAILABLE', statusCode: 503 }}
 */
export const assertDispatchAvailable = async ({ getRuntimeContext, getBackgroundContext = null }) => {
  // Inline helper — mirror of hasUsableContext inside createDispatchScheduler
  const isUsable = (ctx) => Boolean(ctx && (ctx.isWebhook || String(ctx.authId || '').trim()));

  let ctx = null;
  if (typeof getBackgroundContext === 'function') {
    ctx = await getBackgroundContext().catch(() => null);
    if (isUsable(ctx)) return; // webhook context is live
  }

  ctx = await getRuntimeContext().catch(() => null);
  if (isUsable(ctx)) return; // admin session context is live

  const err = new Error('Dispatch context unavailable — no active Bitrix24 session');
  err.code = 'BOT_UNAVAILABLE';
  err.statusCode = 503;
  throw err;
};

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
  executeBatchLimit = Number(process.env.DISPATCH_EXECUTE_BATCH_LIMIT || 20),
  // Stale planned-slot finisher: slots with status 'reserved' older than this
  // threshold are retried (context live) or marked failed (context dead).
  stalePlannedMinutes = (() => {
    const parsed = Number(process.env.DISPATCH_STALE_PLANNED_MINUTES);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : STALE_PLANNED_MINUTES_DEFAULT;
  })(),
  // dispatchLogStore: optional, needed for stale-slot finisher
  dispatchLogStore = null,
  // Resilience deps (all optional, backward-compatible):
  //  - getBackgroundContext: a context for background tasks (generation +
  //    execution) that does NOT depend on a per-user OAuth session — typically
  //    an inbound-webhook context. Defaults to getRuntimeContext so behavior is
  //    unchanged when no webhook is configured.
  //  - planMirror: durable plan storage in Bitrix app.option (write + rehydrate)
  //  - notificationService + getReviewerUserIds: for the "plan not generated" alert
  getBackgroundContext = null,
  planMirror = null,
  notificationService = null,
  getReviewerUserIds = null,
  // S8-A3: reportsStore — для проверки статуса отчёта при исполнении reminder-точек
  // OR-6: проверяем локальный статус (без CRM-запроса)
  reportsStore = null
}) => {
  let dispatchTask = null;
  let timeoutTask = null;
  let generationTask = null;
  let lastSlotKey = '';
  let alertSentForDate = '';

  // Throttle repeated "missing auth/webhook context" warns to 1 line per 5 min.
  const throttledLog = createThrottledLog({ logger });

  // Background context for generation/execution: prefer the injected webhook
  // context, fall back to the per-user runtime context (legacy behavior).
  const resolveBackgroundContext = async () => {
    if (typeof getBackgroundContext === 'function') {
      const ctx = await getBackgroundContext().catch(() => null);
      if (ctx && (ctx.isWebhook || String(ctx.authId || '').trim())) {
        return ctx;
      }
    }
    return getRuntimeContext().catch(() => ({}));
  };

  // A context is usable for background Bitrix calls if it's a webhook OR carries an authId.
  const hasUsableContext = (ctx) => Boolean(ctx && (ctx.isWebhook || String(ctx.authId || '').trim()));

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
      return { ok: false, reason: 'missing_deps' };
    }
    const settings = settingsStore ? await settingsStore.read() : {};
    const context = await resolveBackgroundContext();
    if (!hasUsableContext(context)) {
      throttledLog(
        'dispatchScheduler.generatePlanForDate.no_context',
        'warn',
        'dispatchScheduler: generatePlanForDate skipped — missing auth/webhook context',
        { dateKey }
      );
      return { ok: false, reason: 'no_context' };
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

    // Durable mirror: persist the freshly generated plan to Bitrix app.option so
    // it survives a redeploy that wipes the DB. Best-effort — never fail the run.
    if (planMirror && summary && Number(summary.planned) > 0) {
      try {
        const rows = await dispatchPlanStore.listByDate({ planDate: dateKey });
        await planMirror.write({ context, planDate: dateKey, rows });
        logger.info('dispatchScheduler: plan mirrored to Bitrix', { planDate: dateKey, rows: rows.length });
      } catch (error) {
        logger.warn('dispatchScheduler: plan mirror write failed', { planDate: dateKey, message: error.message });
      }
    }
    return { ok: true, planned: Number(summary?.planned || 0) };
  };

  // Whether a plan already exists for the date (DB first, then Bitrix mirror).
  const planExistsForDate = async (dateKey, context) => {
    try {
      const rows = await dispatchPlanStore.listByDate({ planDate: dateKey });
      if (Array.isArray(rows) && rows.length > 0) return true;
    } catch { /* fall through to mirror */ }
    if (planMirror) {
      try {
        const restored = await planMirror.rehydrateIfEmpty({ context, planDate: dateKey });
        if (restored > 0) return true;
      } catch { /* ignore */ }
    }
    return false;
  };

  // Send a one-per-day alert to reviewers when no plan exists for today.
  const alertNoPlan = async (dateKey, context) => {
    if (alertSentForDate === dateKey) return;
    if (!notificationService || typeof notificationService.notifyDispatch !== 'function') return;
    if (typeof getReviewerUserIds !== 'function') return;
    let userIds = [];
    try {
      userIds = await getReviewerUserIds({ context });
    } catch { userIds = []; }
    const recipients = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => id > 0))];
    if (!recipients.length) return;
    for (const userId of recipients) {
      try {
        await notificationService.notifyDispatch({
          userId,
          message: 'План рассылки на сегодня не сформирован. Откройте приложение и нажмите «Сформировать график».',
          context
        });
      } catch (error) {
        logger.warn('dispatchScheduler: alertNoPlan notify failed', { userId, message: error.message });
      }
    }
    alertSentForDate = dateKey;
    logger.warn('dispatchScheduler: alert sent — no plan for date', { dateKey, recipients: recipients.length });
  };

  // ---------------------------------------------------------------------------
  // Plan-mode: execute due plan rows (called every minute tick when flag ON)
  // ---------------------------------------------------------------------------
  const executeDuePlans = async () => {
    if (!dispatchPlanStore) {
      logger.warn('dispatchScheduler: executeDuePlans skipped — no dispatchPlanStore');
      return { due: 0, executed: 0, duplicates: 0, failed: 0 };
    }

    const context = await resolveBackgroundContext();
    if (!hasUsableContext(context)) {
      throttledLog(
        'dispatchScheduler.executeDuePlans.no_context',
        'warn',
        'dispatchScheduler: executeDuePlans skipped — missing auth/webhook context',
        {}
      );
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
      // S8-A3: определяем тип точки плана (primary или reminder)
      // Строки без entry_type (до миграции) считаются primary (обратная совместимость)
      const entryType = row.entry_type || 'primary';

      // -----------------------------------------------------------------------
      // S8-A3: Исполнитель напоминаний (§4.2.3)
      // При entry_type='reminder' — проверяем статус отчёта (OR-6: локальный статус)
      // Сдан (done/submitted) → пропускаем. Не сдан → переотправляем уведомление.
      // -----------------------------------------------------------------------
      if (entryType === 'reminder') {
        // reminderSlotKey = planDate:baseTimeHHmm:reminder:windowIndex (§4.2.4)
        const windowIndex = row.window_index ?? 1;
        const reminderSlotKey = `${row.plan_date}:${row.base_time}:reminder:${windowIndex}`;

        // Идемпотентность: reserve reminderSlotKey — если уже зарезервирован → пропуск
        let reminderReserve = { reserved: true };
        if (dispatchLogStore) {
          try {
            reminderReserve = await dispatchLogStore.reserve({
              slotKey: reminderSlotKey,
              azsId: String(row.azs_id),
              adminUserId: Number(row.admin_user_id),
              status: 'reserved'
            });
          } catch (err) {
            logger.warn('dispatchScheduler: reminder reserve failed', {
              id: row.id, reminderSlotKey, message: err.message
            });
            await dispatchPlanStore.markFailed({ id: row.id, error: err.message || 'reminder reserve failed' });
            failed += 1;
            continue;
          }
        }

        if (!reminderReserve.reserved) {
          // Уже обработано (дублирующий тик) — помечаем dispatched и пропускаем
          await dispatchPlanStore.markDispatched({ id: row.id, reportItemId: null });
          duplicates += 1;
          continue;
        }

        // Проверяем статус отчёта (OR-6: локальный статус, без CRM-запроса)
        let reportStatus = null;
        if (reportsStore && typeof reportsStore.getBySlotKey === 'function') {
          try {
            // Первичный slotKey = planDate:baseTime основной точки (без суффикса)
            // Ищем по originalSlotKey = planDate:primaryBaseTime (windowIndex=0)
            // В реальном приложении нужно хранить связку, здесь используем plan_date:base_time primary-строки.
            // Для упрощения ищем по azsId + plan_date с ANY слотом (getBySlotKey принимает slotKey)
            // Строим primary slotKey: planDate:base_time (без reminder-суффикса)
            const primarySlotKey = `${row.plan_date}:${row.base_time}`;
            const report = await reportsStore.getBySlotKey({ slotKey: primarySlotKey, azsId: row.azs_id });
            reportStatus = report?.status ?? null;
          } catch (err) {
            logger.warn('dispatchScheduler: reminder getBySlotKey failed', {
              id: row.id, message: err.message
            });
            // Продолжаем — при ошибке проверки считаем не сданным и шлём уведомление
          }
        }

        // Сданный статус (done или submitted) → пропускаем напоминание
        const isSubmitted = reportStatus === 'done' || reportStatus === 'submitted';
        if (isSubmitted) {
          logger.info('dispatchScheduler: reminder skipped — report already submitted', {
            id: row.id, azsId: row.azs_id, planDate: row.plan_date, reportStatus
          });
          await dispatchPlanStore.markDispatched({ id: row.id, reportItemId: null });
          executed += 1; // считаем как обработанную (skipped)
          continue;
        }

        // Отчёт не сдан → переотправляем уведомление (БЕЗ создания новой CRM-карточки)
        try {
          if (notificationService && typeof notificationService.notify === 'function') {
            await notificationService.notify({
              userId: Number(row.admin_user_id),
              azsId: row.azs_id,
              planDate: row.plan_date,
              windowIndex,
              message: `Напоминание: не сдан фото-отчёт за ${row.plan_date}. Пожалуйста, отправьте отчёт.`,
              context
            });
          }
          await dispatchPlanStore.markDispatched({ id: row.id, reportItemId: null });
          executed += 1;
        } catch (err) {
          logger.warn('dispatchScheduler: reminder notify failed', {
            id: row.id, azsId: row.azs_id, message: err.message
          });
          await dispatchPlanStore.markFailed({ id: row.id, error: err.message || 'reminder notify failed' });
          failed += 1;
        }
        continue;
      }

      // -----------------------------------------------------------------------
      // Обычная (primary) точка — стандартный dispatchBatch
      // -----------------------------------------------------------------------
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
  // Per-tick resilience: make sure today's plan exists (retry generation if it
  // doesn't — e.g. the 00:01 cron skipped because no context was available yet),
  // then execute due rows. Alerts reviewers once/day if a plan still can't be built.
  const ensurePlanThenExecute = async () => {
    const timezone = String(
      (settingsStore ? (await settingsStore.read().catch(() => ({}))) : {})?.timezone
      || process.env.DEFAULT_TIMEZONE || 'Europe/Moscow'
    ).trim();
    const today = getTimeParts(nowFn(), timezone).dateKey;
    const context = await resolveBackgroundContext();

    const exists = await planExistsForDate(today, context);
    if (!exists) {
      if (hasUsableContext(context)) {
        logger.info('dispatchScheduler: no plan for today, retrying generation', { today });
        const gen = await generatePlanForDate(today).catch((error) => {
          logger.warn('dispatchScheduler: retry generation failed', { today, message: error.message });
          return { ok: false };
        });
        if (!gen.ok || !gen.planned) {
          await alertNoPlan(today, context);
        }
      } else {
        // Can't generate without a context — surface it so a human can act.
        await alertNoPlan(today, context);
      }
    }

    return executeDuePlans();
  };

  // ---------------------------------------------------------------------------
  // Stale-planned finisher (BUG-009)
  // ---------------------------------------------------------------------------
  // At each tick, look for dispatch_log rows that are still 'reserved' but were
  // created more than `stalePlannedMinutes` minutes ago. These are slots whose
  // original send-time tick was missed (e.g. no auth context available at the
  // moment of the scheduled send). Depending on the current context:
  //   - context live  → dispatch via dispatchService (normal send path)
  //   - context dead  → mark failed with 'skipped: no auth context at send time'
  //
  // Idempotent: once a row is failed/done it no longer matches the WHERE clause.
  // ---------------------------------------------------------------------------
  const finishStalePlannedSlots = async () => {
    if (!dispatchLogStore || typeof dispatchLogStore.listStalePlanned !== 'function') {
      return { stale: 0, executed: 0, failed: 0 };
    }

    const staleBefore = new Date(nowFn().getTime() - stalePlannedMinutes * 60 * 1000);
    let rows;
    try {
      rows = await dispatchLogStore.listStalePlanned({ staleBefore });
    } catch (error) {
      logger.warn('dispatchScheduler: finishStalePlannedSlots: listStalePlanned failed', { message: error.message });
      return { stale: 0, executed: 0, failed: 0 };
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return { stale: 0, executed: 0, failed: 0 };
    }

    logger.warn('dispatchScheduler: stale planned slots found', {
      count: rows.length,
      stalePlannedMinutes,
      staleBefore: staleBefore.toISOString()
    });

    const context = await resolveBackgroundContext();
    const contextUsable = hasUsableContext(context);

    let executed = 0;
    let failed = 0;

    for (const row of rows) {
      if (!contextUsable) {
        try {
          await dispatchLogStore.markFailed({
            id: row.id,
            errorText: 'skipped: no auth context at send time'
          });
          failed += 1;
          logger.warn('dispatchScheduler: stale slot marked failed — no auth context', {
            id: row.id,
            slotKey: row.slot_key,
            azsId: row.azs_id
          });
        } catch (markError) {
          logger.warn('dispatchScheduler: stale slot markFailed error', { id: row.id, message: markError.message });
        }
        continue;
      }

      // Context is live — attempt dispatch through the normal service path.
      // Extract slotDate + slotHHmm from the stored slot_key so the slot is
      // reproduced correctly (key format: [manual:]YYYY-MM-DD:HHmm).
      try {
        const rawKey = String(row.slot_key || '');
        const keyParts = rawKey.split(':');
        // strip optional 'manual' prefix
        const dateHhmmParts = keyParts[0].toLowerCase() === 'manual' ? keyParts.slice(1) : keyParts;
        const slotDate = dateHhmmParts[0] || '';
        const slotHHmm = dateHhmmParts[1] || '';

        const result = await dispatchService.dispatchBatch({
          candidates: [{
            azsId: String(row.azs_id),
            adminUserId: Number(row.admin_user_id),
            slotDate,
            slotHHmm
          }],
          trigger: rawKey.toLowerCase().startsWith('manual:') ? 'manual' : 'auto',
          context
        });

        const item = result?.items?.[0];
        if (item?.ok || item?.duplicate) {
          executed += 1;
          logger.info('dispatchScheduler: stale slot executed', {
            id: row.id,
            slotKey: row.slot_key,
            azsId: row.azs_id,
            duplicate: Boolean(item.duplicate)
          });
        } else {
          // dispatchBatch already marked the slot failed internally; count it
          failed += 1;
          logger.warn('dispatchScheduler: stale slot dispatch returned not-ok', {
            id: row.id,
            slotKey: row.slot_key,
            azsId: row.azs_id,
            error: item?.error
          });
        }
      } catch (dispatchError) {
        // Best-effort: try to mark failed if possible
        try {
          await dispatchLogStore.markFailed({
            id: row.id,
            errorText: `stale dispatch error: ${dispatchError.message || String(dispatchError)}`
          });
        } catch { /* ignore secondary error */ }
        failed += 1;
        logger.warn('dispatchScheduler: stale slot dispatch threw', {
          id: row.id,
          slotKey: row.slot_key,
          azsId: row.azs_id,
          message: dispatchError.message
        });
      }
    }

    return { stale: rows.length, executed, failed };
  };

  const runOnce = async () => {
    // Safety switch: when plan mode is ON, ensure today's plan then execute due
    // rows instead of the old slot-matching behavior. The old body below is untouched.
    if (planModeEnabled) {
      const staleResult = await finishStalePlannedSlots().catch((err) => {
        logger.warn('dispatchScheduler: finishStalePlannedSlots threw', { message: err.message });
        return { stale: 0, executed: 0, failed: 0 };
      });
      const planResult = await ensurePlanThenExecute();
      return { ...planResult, stale: staleResult };
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
      throttledLog(
        'dispatchScheduler.auth_context_unavailable',
        'warn',
        'dispatchScheduler: auth_context_unavailable',
        { slotKey, reason: 'missing_auth_id' }
      );
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
    // Also finish any stale reserved slots (best-effort, does not block)
    finishStalePlannedSlots().catch((err) => {
      logger.warn('dispatchScheduler: finishStalePlannedSlots threw (legacy path)', { message: err.message });
    });
    return dispatchService.dispatchBatch({ candidates, trigger: 'auto', context });
  };

  // ---------------------------------------------------------------------------
  // Overlap guards (S1-03): each cron callback gets its own guard so a slow
  // Bitrix response can never cause two concurrent runs of the same job type.
  // onSkip emits a warn-level log with a structured marker for alerting.
  // ---------------------------------------------------------------------------
  const guardedDispatchTick = createGuardedTick({
    runOnce,
    onSkip: () => logger.warn('dispatchScheduler: dispatch.tick_skipped_overlap — previous tick still running, skipping')
  });

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
        const result = await guardedDispatchTick();
        if (!result?.skipped) {
          logger.info('dispatchScheduler: run finished', result.summary ?? result);
        }
      } catch (error) {
        logger.error('dispatchScheduler: run failed', { error: error.message });
      }
    });

    logger.info('dispatchScheduler: started', { cronExpression });

    if (timeoutWatcher && typeof timeoutWatcher.runOnce === 'function') {
      const guardedTimeoutTick = createGuardedTick({
        runOnce: async () => {
          const context = await getRuntimeContext().catch(() => ({}));
          return timeoutWatcher.runOnce({ context });
        },
        onSkip: () => logger.warn('dispatchScheduler: timeout.tick_skipped_overlap — previous tick still running, skipping')
      });

      timeoutTask = cron.schedule(timeoutCronExpression, async () => {
        try {
          const result = await guardedTimeoutTick();
          if (!result?.skipped) {
            logger.info('timeoutScheduler: run finished', result);
          }
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

      const guardedGenerationTick = createGuardedTick({
        runOnce: async () => {
          // "today" in the configured settings timezone — so '1 0 * * *' means
          // 00:01 in the settings tz, and dateKey is also the settings-tz date.
          const today = getTimeParts(nowFn(), planTz).dateKey;
          return generatePlanForDate(today);
        },
        onSkip: () => logger.warn('dispatchScheduler: generation.tick_skipped_overlap — previous tick still running, skipping')
      });

      generationTask = cron.schedule(planGenerationCron, async () => {
        try {
          const result = await guardedGenerationTick();
          if (!result?.skipped) {
            logger.info('dispatchScheduler: generation cron finished', result);
          }
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
    // Exposed for direct invocation (tests, boot bootstrap, manual trigger).
    // The guarded variant is used so the public interface is also overlap-safe.
    runOnce: guardedDispatchTick,
    // Exposed for tests and manual invocation.
    finishStalePlannedSlots
  };
};

export default createDispatchScheduler;
