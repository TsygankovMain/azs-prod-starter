/**
 * dispatchPlanGenerator.js
 *
 * Pure helper + orchestrator for generating a daily dispatch plan.
 *
 * TIMEZONE SEMANTICS (C1 fix):
 * `computeExecuteAt` now treats baseTime and workWindow boundaries as wall-clock
 * times in `settings.timezone` (e.g. 'Europe/Moscow'). For example, baseTime
 * '0900' with timezone 'Europe/Moscow' (UTC+3, no DST) produces execute_at at
 * 06:00 UTC — matching the old dispatchScheduler behaviour where 09:00 fires at
 * 09:00 Moscow time.
 *
 * When timezone is undefined/'' the function falls back to treating times as UTC
 * (legacy behaviour), so all existing tests without a timezone remain passing.
 *
 * SLOT KEY SAFETY:
 * dispatchService.buildSlotKey is `${slotDate}:${normalizeSlot(slotHHmm)}` — pure
 * string concat, NOT affected by UTC arithmetic. The executor passes
 * slotDate=plan_date and slotHHmm=base_time, so idempotency is UNAFFECTED by this
 * change. dispatchService.js is NOT touched.
 *
 * DST NOTE:
 * For fixed-offset zones (Europe/Moscow, UTC+3, no DST) the conversion is exact.
 * For DST zones there is a ≤1 h ambiguity at the transition instant only —
 * acceptable for a production dispatch scheduler.
 */

import { pickJitterMinutes } from './dispatchService.js';
import { resolveProfileForAzs } from './dispatchProfileResolver.js';

const MINUTES_TO_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// S8-A3: Детерминированный PRNG (djb2 seed → mulberry32)
// ---------------------------------------------------------------------------

/**
 * djb2 hash функция для строки.
 * Возвращает 32-битное беззнаковое число (0..2^32-1).
 * @param {string} str
 * @returns {number}
 */
const djb2Hash = (str) => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // hash * 33 ^ char
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // force unsigned 32-bit
  }
  return hash >>> 0;
};

/**
 * Mulberry32 PRNG — возвращает функцию rng() → [0, 1).
 * Детерминирован при одном seed.
 * @param {number} seed Unsigned 32-bit integer
 * @returns {() => number}
 */
const makeMulberry32 = (seed) => {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Выбирает детерминированный случайный момент (HHMM) внутри одного окна.
 * Seed = djb2(planDate + ':' + azsId + ':' + windowIndex).
 *
 * @param {string} planDate       'YYYY-MM-DD'
 * @param {string} azsId          ID АЗС
 * @param {{ from: string, to: string }} window  { from: 'HH:MM', to: 'HH:MM' }
 * @param {number} windowIndex    Индекс окна (0 = primary, 1..N = reminder)
 * @returns {string}              HHMM, детерминированный момент внутри окна
 */
export const pickRandomMomentInWindow = (planDate, azsId, window, windowIndex) => {
  const seedStr = `${planDate}:${azsId}:${windowIndex}`;
  const seed = djb2Hash(seedStr);
  const rng = makeMulberry32(seed);

  const fromHHMM = String(window.from || '').replace(':', '');
  const toHHMM = String(window.to || '').replace(':', '');
  const fromMinutes = Number(fromHHMM.slice(0, 2)) * 60 + Number(fromHHMM.slice(2, 4));
  const toMinutes = Number(toHHMM.slice(0, 2)) * 60 + Number(toHHMM.slice(2, 4));

  if (fromMinutes >= toMinutes) {
    // Защита: вернуть начало окна если окно некорректное
    return fromHHMM.padStart(4, '0');
  }

  const rangeMinutes = toMinutes - fromMinutes;
  const pickedMinute = fromMinutes + Math.floor(rng() * rangeMinutes);

  const h = Math.floor(pickedMinute / 60);
  const m = pickedMinute % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/**
 * Return the offset (ms) of `timeZone` at the given instant:
 *   (wall-clock time shown in the tz) - (UTC time)
 * e.g. Moscow UTC+3 → +10_800_000.
 *
 * Uses Intl.DateTimeFormat to read the wall-clock representation, then computes
 * Date.UTC of those parts and subtracts the real UTC timestamp.
 *
 * @param {Date}   date     The instant to evaluate the offset at.
 * @param {string} timeZone IANA timezone string, e.g. 'Europe/Moscow'.
 * @returns {number} Offset in milliseconds.
 */
const tzOffsetMs = (date, timeZone) => {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second)
  );
  return asUTC - date.getTime();
};

/**
 * Build the UTC instant that corresponds to wall-clock HHMM on `planDate` in
 * `timeZone`.  If `timeZone` is falsy, falls back to UTC interpretation
 * (legacy behaviour — keeps existing tests passing when timezone is absent).
 *
 * Algorithm:
 *  1. Build the naive UTC midnight of planDate and set HHMM via setUTCHours
 *     → this is the "UTC guess" (correct answer when zone IS UTC).
 *  2. Compute the tz offset at that instant via Intl.
 *  3. Subtract the offset so the resulting instant, when formatted in the tz,
 *     shows exactly HHMM.
 *
 * For fixed-offset zones (Moscow UTC+3) this is exact.  For DST zones there is
 * a ≤1 h ambiguity at the transition instant — acceptable.
 *
 * @param {string}          planDate 'YYYY-MM-DD'
 * @param {string|number}   hhmm     'HHMM' 4-char (or numeric, e.g. '0900')
 * @param {string|undefined} timeZone IANA tz or falsy for UTC legacy
 * @returns {Date}
 */
export const buildZonedDatetime = (planDate, hhmm, timeZone) => {
  const h = Number(String(hhmm).slice(0, 2));
  const m = Number(String(hhmm).slice(2, 4));
  const utcGuess = new Date(`${planDate}T00:00:00.000Z`);
  if (Number.isNaN(utcGuess.getTime())) {
    throw new Error(`buildZonedDatetime: invalid planDate "${planDate}"`);
  }
  utcGuess.setUTCHours(h, m, 0, 0);
  if (!timeZone) return utcGuess; // legacy UTC fallback — no tz conversion
  const offset = tzOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
};

// ---------------------------------------------------------------------------
// Local helpers (backward-compat UTC path kept for callers that pass no tz)
// ---------------------------------------------------------------------------

/**
 * Build a UTC Date for `planDate` at the given `HHMM` string.
 * Mirrors parseSlotDateTimeUtc in dispatchService.js exactly.
 * Kept for internal reference; buildZonedDatetime replaces it when tz is given.
 */
const buildUtcDatetime = (planDate, hhmm) => buildZonedDatetime(planDate, hhmm, '');

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
 *   Boundaries are interpreted in the same timezone as baseTime.
 * @param {string|undefined} params.timezone
 *   IANA timezone string (e.g. 'Europe/Moscow').  When present, baseTime and
 *   workWindow boundaries are treated as wall-clock times in this timezone.
 *   When absent/falsy, UTC is used (legacy behaviour — existing tests unaffected).
 * @returns {{ executeAt: Date }}
 */
export const computeExecuteAt = ({ planDate, baseTime, jitterMinutes, workWindow, timezone }) => {
  const tz = timezone || ''; // empty string → UTC legacy path in buildZonedDatetime
  const base = buildZonedDatetime(planDate, baseTime, tz);
  let executeAt = addMinutes(base, jitterMinutes);

  if (workWindow) {
    // Parse window boundaries in the same tz so the window means wall-clock hours
    const windowStartHhmm = String(workWindow.start || '').replace(':', '');
    const windowEndHhmm = String(workWindow.end || '').replace(':', '');
    const windowStart = buildZonedDatetime(planDate, windowStartHhmm, tz);
    const windowEnd = buildZonedDatetime(planDate, windowEndHhmm, tz);

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

    // S8-A2: резолвим профиль per-AZS
    const profile = resolveProfileForAzs(candidate.azsId, settings);

    // ---------------------------------------------------------------------------
    // S8-A3: защитный гвард — неизвестный mode или невалидный config → warn + фоллбэк
    // ---------------------------------------------------------------------------
    if (profile !== null) {
      const profileMode = profile.mode;
      const profileConfig = profile.config;

      // Проверяем: mode должен быть A или B, config должен быть непустым объектом
      const hasValidMode = profileMode === 'A' || profileMode === 'B';
      const hasValidConfig = profileConfig !== null && typeof profileConfig === 'object';

      if (!hasValidMode || !hasValidConfig) {
        logger.warn(
          `[generateDailyPlan] Profile '${profile.id}' has invalid mode='${profileMode}' or missing config. ` +
          `Falling back to global schedule for azsId='${candidate.azsId}'.`
        );
        // Фоллбэк: использовать глобальное расписание (то же что при profile=null)
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
        continue;
      }

      // Проверяем: режим A требует непустых slots, режим B — непустых windows
      if (profileMode === 'A') {
        const slots = normalizeBaseTimes(profileConfig.slots);
        if (slots.length === 0) {
          logger.warn(
            `[generateDailyPlan] Profile '${profile.id}' mode A has no valid slots. ` +
            `Falling back to global schedule for azsId='${candidate.azsId}'.`
          );
          for (const baseTime of baseTimes) {
            const jitterMinutes = pickJitterMinutes(jitterLimit, rng);
            const { executeAt } = computeExecuteAt({
              planDate, baseTime, jitterMinutes, workWindow, timezone
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
          continue;
        }
      }

      if (profileMode === 'B') {
        const windows = Array.isArray(profileConfig.windows) ? profileConfig.windows : [];
        if (windows.length === 0) {
          logger.warn(
            `[generateDailyPlan] Profile '${profile.id}' mode B has no valid windows. ` +
            `Falling back to global schedule for azsId='${candidate.azsId}'.`
          );
          for (const baseTime of baseTimes) {
            const jitterMinutes = pickJitterMinutes(jitterLimit, rng);
            const { executeAt } = computeExecuteAt({
              planDate, baseTime, jitterMinutes, workWindow, timezone
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
          continue;
        }

        // -----------------------------------------------------------------------
        // S8-A3: Режим B — генерация точек по окнам
        // -----------------------------------------------------------------------
        const escalate = profileConfig.escalateUntilDone !== false; // дефолт true

        // Дедлайн = конец ПОСЛЕДНЕГО окна (§4.2.2)
        const lastWindow = windows[windows.length - 1];
        const lastWindowEndHHMM = String(lastWindow.to || '').replace(':', '').padStart(4, '0');
        const deadlineAt = buildZonedDatetime(planDate, lastWindowEndHHMM, timezone);

        // Первичная точка: окно[0] (§4.2.2)
        const primaryWindow = windows[0];
        const primaryBaseTime = pickRandomMomentInWindow(
          planDate, candidate.azsId, primaryWindow, 0
        );
        const primaryExecuteAt = buildZonedDatetime(planDate, primaryBaseTime, timezone);

        await planStore.upsertPlanned({
          planDate,
          azsId: candidate.azsId,
          adminUserId: Number(candidate.adminUserId),
          baseTime: primaryBaseTime,
          executeAt: primaryExecuteAt,
          jitterMinutes: 0,
          entryType: 'primary',
          windowIndex: 0,
          deadlineAt
        });
        planned += 1;

        // Напоминание-точки: окна[1..N-1] если escalateUntilDone
        if (escalate) {
          for (let i = 1; i < windows.length; i++) {
            const reminderWindow = windows[i];
            const reminderBaseTime = pickRandomMomentInWindow(
              planDate, candidate.azsId, reminderWindow, i
            );
            const reminderExecuteAt = buildZonedDatetime(planDate, reminderBaseTime, timezone);

            await planStore.upsertPlanned({
              planDate,
              azsId: candidate.azsId,
              adminUserId: Number(candidate.adminUserId),
              baseTime: reminderBaseTime,
              executeAt: reminderExecuteAt,
              jitterMinutes: 0,
              entryType: 'reminder',
              windowIndex: i,
              deadlineAt
            });
            planned += 1;
          }
        }

        continue; // режим B обработан — не падать в режим A ниже
      }
    }

    // ---------------------------------------------------------------------------
    // Режим A (профиль) или глобальный (нет профиля)
    // ---------------------------------------------------------------------------

    // Определяем источник слотов, джиттера и workWindow:
    //   - профиль режима A → profile.config.slots + profile.config.jitterMinutes;
    //     глобальный workWindow НЕ применяется (слоты профиля не должны обрезаться глобальным окном)
    //   - null (нет профиля) → глобальные settings.report.dispatchTimes + dispatchJitterMinutes + workWindow
    const isProfileA = profile !== null && profile.mode === 'A';
    const effectiveBaseTimes = isProfileA
      ? normalizeBaseTimes(profile.config.slots)
      : baseTimes;
    const effectiveJitterLimit = isProfileA
      ? Number(profile.config.jitterMinutes ?? 0)
      : jitterLimit;
    const effectiveWorkWindow = isProfileA
      ? undefined   // профиль A: без глобального clamping, слоты профиля и есть расписание
      : workWindow;

    for (const baseTime of effectiveBaseTimes) {
      const jitterMinutes = pickJitterMinutes(effectiveJitterLimit, rng);
      const { executeAt } = computeExecuteAt({
        planDate,
        baseTime,
        jitterMinutes,
        workWindow: effectiveWorkWindow,
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

export default { computeExecuteAt, normalizeBaseTimes, generateDailyPlan, buildZonedDatetime, pickRandomMomentInWindow };
