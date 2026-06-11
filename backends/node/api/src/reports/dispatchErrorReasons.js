import { NOTIFY_FALLBACK_PREFIX } from '../notifications/notificationService.js';

/**
 * @typedef {'NOTIFY_FALLBACK'|'NO_AUTH_CONTEXT'|'OAUTH_REFRESH_FAILED'|'KEYBOARD_REJECTED'|'BOT_MISSING'|'BITRIX_5XX'|'UNKNOWN'} ReasonCode
 */

/**
 * @typedef {{ reasonCode: ReasonCode, isFallback: boolean }} DispatchErrorClassification
 */

/**
 * Classifies a dispatch_log.error_text string into a structured reason code.
 *
 * Matching is case-insensitive. The first matching pattern wins.
 * `isFallback` is true when the error_text starts with NOTIFY_FALLBACK_PREFIX,
 * meaning the bot channel failed but the notify channel delivered the message.
 *
 * @param {string | null | undefined} errorText - Raw value from dispatch_log.error_text
 * @returns {DispatchErrorClassification}
 */
export const classifyDispatchError = (errorText) => {
  const text = String(errorText || '').trim();

  if (!text) {
    return { reasonCode: 'UNKNOWN', isFallback: false };
  }

  /** Whether the message was ultimately delivered via im.notify fallback */
  const isFallback = text.startsWith(NOTIFY_FALLBACK_PREFIX);

  if (isFallback) {
    return { reasonCode: 'NOTIFY_FALLBACK', isFallback: true };
  }

  /**
   * NO_AUTH_CONTEXT — slot was triggered but no OAuth context was available.
   * Produced by W1-3 "skipped: no auth context at send time".
   */
  if (/no auth context/i.test(text)) {
    return { reasonCode: 'NO_AUTH_CONTEXT', isFallback: false };
  }

  /**
   * OAUTH_REFRESH_FAILED — OAuth token refresh failed due to wrong credentials
   * or expired refresh token (Bitrix returns `wrong_client` / `refresh failed`).
   */
  if (/wrong_client|refresh failed/i.test(text)) {
    return { reasonCode: 'OAUTH_REFRESH_FAILED', isFallback: false };
  }

  /**
   * KEYBOARD_REJECTED — Bitrix rejected the message because of malformed keyboard
   * structure (PARAM_KEYBOARD_ERROR from imbot API).
   */
  if (/PARAM_KEYBOARD/i.test(text)) {
    return { reasonCode: 'KEYBOARD_REJECTED', isFallback: false };
  }

  /**
   * BOT_MISSING — The registered bot is not found on the portal, either because
   * BOT_ID is wrong or the bot was deleted/unregistered.
   */
  if (/BOT_ID|bot not found/i.test(text)) {
    return { reasonCode: 'BOT_MISSING', isFallback: false };
  }

  /**
   * BITRIX_5XX — Bitrix24 responded with a 5xx HTTP error, timed out, or the
   * network connection was reset (ETIMEDOUT / timeout / HTTP 5xx).
   */
  if (/HTTP 5|timeout|ETIMEDOUT/i.test(text)) {
    return { reasonCode: 'BITRIX_5XX', isFallback: false };
  }

  /**
   * UNKNOWN — Error text is present but does not match any known pattern.
   */
  return { reasonCode: 'UNKNOWN', isFallback: false };
};
