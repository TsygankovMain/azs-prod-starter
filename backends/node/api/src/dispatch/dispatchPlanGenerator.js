/**
 * dispatchPlanGenerator.js
 *
 * Pure helper + orchestrator for generating a daily dispatch plan.
 *
 * IMPORTANT — UTC-based time building (consistency with dispatchService):
 * This module builds slot datetimes the SAME way as
 * dispatchService.parseSlotDateTimeUtc:
 *   new Date(`${planDate}T00:00:00.000Z`)  then  setUTCHours(HH, MM, 0, 0)
 *
 * That means baseTime and workWindow boundaries are treated as UTC clock times,
 * NOT as local times in the configured timezone. This matches dispatchService
 * exactly — when the executor later calls dispatchService.dispatchCandidate with
 * slotDate/slotHHmm = planDate/baseTime, it rebuilds the slot via
 * parseSlotDateTimeUtc using the same arithmetic, so the two values AGREE.
 *
 * If true timezone-aware scheduling is ever needed, BOTH files must be updated
 * together to avoid a mismatch between planned executeAt and the executor's
 * slot key reconstruction.
 */

import { pickJitterMinutes } from './dispatchService.js';

const MINUTES_TO_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Local helpers (identical logic to dispatchService internals, kept in sync)
// ---------------------------------------------------------------------------

/**
 * Build a UTC Date for `planDate` at the given `HHMM` string.
 * Mirrors parseSlotDateTimeUtc in dispatchService.js exactly.
 */
const buildUtcDatetime = (planDate, hhmm) => {
  const h = Number(String(hhmm).slice(0, 2));
  const m = Number(String(hhmm).slice(2, 4));
  const d = new Date(`${planDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`buildUtcDatetime: invalid planDate "${planDate}"`);
  }
  d.setUTCHours(h, m, 0, 0);
  return d;
};

/** Add integer minutes to a Date, returns a new Date. */
const addMinutes = (date, minutes) =>
  new Date(new Date(date).getTime() + Number(minutes) * MINUTES_TO_MS);

// ---------------------------------------------------------------------------
// PURE: normalizeBaseTimes
// ---------------------------------------------------------------------------

/**
 * Convert an array of 'HH:MM' strings (settings.report.dispatchTimes) to the
 * canonical 'HHMM' 4-char form used throughout the codebase.
 * Invalid/out-of-range entries are silently dropped; output is sorted and
 * deduplicated (same logic as parseScheduleTimes inside dispatchScheduler.js).
 *
 * @param {string[] | undefined} value
 * @returns {string[]}
 */
export const normalizeBaseTimes = (value) => {
  const source = Array.isArray(value) ? value : [];

  const slots = [...new Set(
    source
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => {
        // Accept both 'HH:MM' and bare 'HHMM'
        const time = item.includes(':') ? item : `${item.slice(0, 2)}:${item.slice(2, 4)}`;
        const match = time.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return '';
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
        return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
      })
      .filter(Boolean)
  )];

  return slots.sort();
};

// ---------------------------------------------------------------------------
// PURE: computeExecuteAt
// ---------------------------------------------------------------------------

/**
 * Compute the jittered (and optionally clamped) executeAt for one
 * planDate × baseTime × jitter combination.
 *
 * @param {object} params
 * @param {string} params.planDate       'YYYY-MM-DD'
 * @param {string} params.baseTime       'HHMM' (4-char, e.g. '0900')
 * @param {number} params.jitterMinutes  integer (negative or positive)
 * @param {{ start: string, end: string } | undefined} params.workWindow
 *   Optional. start/end are 'HH:MM', clamping boundaries on the same planDate.
 * @param {string} params.timezone       Ignored for base-time construction
 *   (kept for future tz-aware extension; currently UTC is used for consistency
 *   with dispatchService.parseSlotDateTimeUtc — see module-level comment).
 * @returns {{ executeAt: Date }}
 */
export const computeExecuteAt = ({ planDate, baseTime, jitterMinutes, workWindow }) => {
  const base = buildUtcDatetime(planDate, baseTime);
  let executeAt = addMinutes(base, jitterMinutes);

  if (workWindow) {
    // Parse window boundaries as UTC times on the same planDate
    const windowStartHhmm = String(workWindow.start || '').replace(':', '');
    const windowEndHhmm = String(workWindow.end || '').replace(':', '');
    const windowStart = buildUtcDatetime(planDate, windowStartHhmm);
    const windowEnd = buildUtcDatetime(planDate, windowEndHhmm);

    if (executeAt < windowStart) {
      executeAt = windowStart;
    } else if (executeAt > windowEnd) {
      executeAt = windowEnd;
    }
  }

  return { executeAt };
};

// ---------------------------------------------------------------------------
// ORCHESTRATOR: generateDailyPlan
// ---------------------------------------------------------------------------

/**
 * Generate (or regenerate) the daily dispatch plan for a given date.
 *
 * @param {object} params
 * @param {string}   params.planDate      'YYYY-MM-DD'
 * @param {Array<{ azsId: string, adminUserId: number }>} params.candidates
 *   Already-loaded AZS candidates (caller wires loadCandidatesFromAzs).
 * @param {object}   params.settings      Full settings object.
 * @param {object}   params.planStore     Has upsertPlanned / deletePlannedForDate.
 * @param {function} [params.rng]         RNG — defaults to Math.random.
 * @param {boolean}  [params.regenerate]  If true, delete existing planned rows first.
 * @param {object}   [params.logger]      Defaults to console.
 * @returns {Promise<{ planDate, azsCount, baseTimes, planned }>}
 */
export const generateDailyPlan = async ({
  planDate,
  candidates,
  settings,
  planStore,
  rng = Math.random,
  regenerate = false,
  logger = console
}) => {
  const baseTimes = normalizeBaseTimes(settings?.report?.dispatchTimes);
  const jitterLimit = Number(settings?.report?.dispatchJitterMinutes || 0);
  const workWindow = settings?.report?.workWindow;
  const timezone = String(settings?.timezone || 'UTC');

  if (regenerate) {
    await planStore.deletePlannedForDate({ planDate });
  }

  let planned = 0;

  for (const candidate of candidates) {
    // Defensive: skip invalid candidates
    if (!candidate?.azsId || !(Number(candidate?.adminUserId) > 0)) {
      logger.warn('generateDailyPlan: skipping invalid candidate', {
        azsId: candidate?.azsId,
        adminUserId: candidate?.adminUserId
      });
      continue;
    }

    for (const baseTime of baseTimes) {
      const jitterMinutes = pickJitterMinutes(jitterLimit, rng);
      const { executeAt } = computeExecuteAt({
        planDate,
        baseTime,
        jitterMinutes,
        workWindow,
        timezone
      });

      await planStore.upsertPlanned({
        planDate,
        azsId: candidate.azsId,
        adminUserId: Number(candidate.adminUserId),
        baseTime,
        executeAt,
        jitterMinutes
      });
      planned += 1;
    }
  }

  return {
    planDate,
    azsCount: candidates.length,
    baseTimes,
    planned
  };
};

export default { computeExecuteAt, normalizeBaseTimes, generateDailyPlan };
