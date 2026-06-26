/**
 * dispatchPlanMirror.js
 *
 * Durable mirror of the daily dispatch plan in Bitrix24 app.option storage.
 *
 * Why: the dispatch_plan DB table lives in a single-container Postgres that is
 * wiped on redeploy. Bitrix app.option is portal-side and survives any redeploy
 * (same mechanism used for settings — see bitrixAppSettingsStore.js). So we keep
 * the DB as the working copy and Bitrix as the safe:
 *   - on generation: write the plan to app.option (mirror)
 *   - on boot/read: if the DB has no plan for today but the mirror does,
 *     rehydrate the DB rows from the mirror (idempotent upsert)
 *
 * The mirror requires a Bitrix token. In background flows that token comes from
 * the inbound webhook context (see webhookContext.js); callers pass it in.
 *
 * Stored JSON shape under option key `azs_dispatch_plan_v1`:
 *   { planDate: 'YYYY-MM-DD', rows: [
 *       { azsId, adminUserId, baseTime, executeAt(ISO), jitterMinutes, status }
 *   ], alertSent: boolean, updatedAt(ISO) }
 */

const DEFAULT_OPTION_KEY = 'azs_dispatch_plan_v1';

const extractOptionValue = (payload, optionKey) => {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.prototype.hasOwnProperty.call(payload, optionKey)) return payload[optionKey];
  if (Object.prototype.hasOwnProperty.call(payload, 'option')) return payload.option;
  return null;
};

const parseMirror = (value) => {
  if (value === null || value === undefined) return null;
  let obj = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return {
    planDate: String(obj.planDate || '').trim(),
    rows: Array.isArray(obj.rows) ? obj.rows : [],
    alertSent: Boolean(obj.alertSent),
    updatedAt: String(obj.updatedAt || '').trim()
  };
};

const toIso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * @param {object} deps
 * @param {object} deps.bitrixClient   - has callMethod(method, params, context)
 * @param {object} deps.planStore      - dispatchPlanStore (upsertPlanned, listByDate)
 * @param {string} [deps.optionKey]
 * @param {object} [deps.logger]
 */
export const createDispatchPlanMirror = ({
  bitrixClient,
  planStore,
  optionKey = DEFAULT_OPTION_KEY,
  logger = console
} = {}) => {
  if (!bitrixClient || typeof bitrixClient.callMethod !== 'function') {
    throw new Error('dispatchPlanMirror requires bitrixClient.callMethod');
  }
  if (!planStore) {
    throw new Error('dispatchPlanMirror requires planStore');
  }
  const key = String(optionKey || '').trim() || DEFAULT_OPTION_KEY;

  const read = async ({ context = {} } = {}) => {
    const result = await bitrixClient.callMethod('app.option.get', { option: key }, context);
    return parseMirror(extractOptionValue(result, key));
  };

  /**
   * Write the plan rows to app.option. `rows` may be DB rows (snake_case) or
   * already-normalized objects — we normalize defensively.
   */
  const write = async ({ context = {}, planDate, rows = [], alertSent = false, now = new Date() } = {}) => {
    const normalizedRows = rows.map((r) => ({
      azsId: String(r.azsId ?? r.azs_id ?? '').trim(),
      adminUserId: Number(r.adminUserId ?? r.admin_user_id ?? 0) || 0,
      baseTime: String(r.baseTime ?? r.base_time ?? '').trim(),
      executeAt: toIso(r.executeAt ?? r.execute_at),
      jitterMinutes: Number(r.jitterMinutes ?? r.jitter_minutes ?? 0) || 0,
      status: String(r.status ?? 'planned').trim()
    })).filter((r) => r.azsId && r.executeAt);

    const payload = {
      planDate: String(planDate || '').trim(),
      rows: normalizedRows,
      alertSent: Boolean(alertSent),
      updatedAt: toIso(now)
    };
    await bitrixClient.callMethod('app.option.set', {
      options: { [key]: JSON.stringify(payload) }
    }, context);
    return payload;
  };

  /**
   * If the DB has no plan rows for `planDate` but the mirror does, restore them
   * into the DB (idempotent). Returns the number of rows rehydrated.
   */
  const rehydrateIfEmpty = async ({ context = {}, planDate }) => {
    const date = String(planDate || '').trim();
    if (!date) return 0;

    let dbRows = [];
    try {
      dbRows = await planStore.listByDate({ planDate: date });
    } catch (error) {
      logger.warn?.('dispatchPlanMirror.listByDate_failed', { message: error.message });
      dbRows = [];
    }
    if (Array.isArray(dbRows) && dbRows.length > 0) {
      return 0; // DB already has the plan — nothing to restore
    }

    let mirror = null;
    try {
      mirror = await read({ context });
    } catch (error) {
      logger.warn?.('dispatchPlanMirror.read_failed', { message: error.message });
      return 0;
    }
    if (!mirror || mirror.planDate !== date || !mirror.rows.length) {
      return 0; // no usable mirror for this date
    }

    let restored = 0;
    for (const row of mirror.rows) {
      // A cancelled slot must stay cancelled across a redeploy — never resurrect it.
      if (String(row.status || 'planned').trim() === 'cancelled') continue;
      try {
        await planStore.upsertPlanned({
          planDate: date,
          azsId: row.azsId,
          adminUserId: row.adminUserId,
          baseTime: row.baseTime,
          executeAt: new Date(row.executeAt),
          jitterMinutes: row.jitterMinutes
        });
        restored += 1;
      } catch (error) {
        logger.warn?.('dispatchPlanMirror.upsert_failed', { azsId: row.azsId, message: error.message });
      }
    }
    logger.info?.('dispatchPlanMirror.rehydrated_from_bitrix', { planDate: date, restored });
    return restored;
  };

  return { read, write, rehydrateIfEmpty, optionKey: key };
};

export default createDispatchPlanMirror;
