/**
 * botEventGate — pure gate function for POST /api/bot/event secret verification.
 *
 * Returns the authorization decision for an incoming /api/bot/event request.
 *   'ok'        → JOB_SECRET set and provided ?s matches → process the event
 *   'reject'    → JOB_SECRET set but ?s missing/wrong → spoof attempt, drop
 *   'no-secret' → JOB_SECRET unset → fail-closed (drop); caller logs one-time warn
 *
 * @param {string|undefined} jobSecret     — value of process.env.JOB_SECRET (raw, may be undefined)
 * @param {string|undefined} providedSecret — value of req.query.s (may be undefined)
 * @returns {'ok'|'reject'|'no-secret'}
 */
export const checkBotEventSecret = (jobSecret, providedSecret) => {
  const secret = String(jobSecret || '').trim();
  if (!secret) return 'no-secret';
  return providedSecret === secret ? 'ok' : 'reject';
};
