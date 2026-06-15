/**
 * resolveInstallAdmin — BUG-S1 follow-up.
 *
 * Derives the `isAdmin` boolean for an incoming /api/install request by
 * calling Bitrix `profile` with a hard fail-fast cap (Promise.race + sentinel).
 * The bitrixRestClient has no per-call retry-disable option, so we wrap the
 * call in a race against a timer that resolves to a sentinel rather than
 * rejecting, keeping the helper's error handling uniform.
 *
 * @param {object}  params
 * @param {object}  params.bitrixClient    — object exposing callMethodWithAuth(method, params, authId, context)
 * @param {string}  [params.authId]        — Bitrix access token; falsy → return false immediately
 * @param {object}  [params.installContext] — { domain, memberId, userId, ... } forwarded to client call
 * @param {number}  [params.timeoutMs]     — fail-fast cap in ms; default 5000
 * @param {object}  [params.logger]        — object with .warn(event, payload); default console
 * @returns {Promise<boolean>}
 */
import { resolveIsAdmin } from './resolveIsAdmin.js';

const TIMEOUT_SENTINEL = Symbol('install_admin_timeout');

/**
 * Returns a promise that resolves to TIMEOUT_SENTINEL after `ms` milliseconds.
 * Never rejects — the race handler decides what to do with it.
 */
const makeTimeoutPromise = (ms) =>
  new Promise((resolve) => setTimeout(() => resolve(TIMEOUT_SENTINEL), ms));

export const resolveInstallAdmin = async ({
  bitrixClient,
  authId,
  installContext = {},
  timeoutMs = 5000,
  logger = console
}) => {
  // No authId → cannot verify, return false without any network call.
  if (!authId) {
    return false;
  }

  let profile;
  try {
    const profileCall = bitrixClient.callMethodWithAuth('profile', {}, authId, installContext);
    const result = await Promise.race([profileCall, makeTimeoutPromise(timeoutMs)]);
    if (result === TIMEOUT_SENTINEL) {
      // Timeout sentinel — treat as unverifiable; warn and return false.
      logger.warn('install_admin_unverified', {
        authId,
        domain: installContext?.domain,
        memberId: installContext?.memberId,
        error: `profile call exceeded timeoutMs (${timeoutMs}ms)`
      });
      return false;
    }
    profile = result;
  } catch (error) {
    logger.warn('install_admin_unverified', {
      authId,
      domain: installContext?.domain,
      memberId: installContext?.memberId,
      error: error?.message
    });
    return false;
  }

  return resolveIsAdmin({
    profileAdminRaw: profile?.ADMIN,
    requestAdminRaw: undefined,
    previousIsAdmin: false
  });
};
