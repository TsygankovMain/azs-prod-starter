// Unified transient-error pattern used by bitrixRestClient, crmSyncWorker, and
// all retry loops. Single source of truth — import instead of copy-pasting.
//
// Members:
//   • Original Bitrix/network errors: OPERATION_TIME_LIMIT, QUERY_LIMIT_EXCEEDED,
//     HTTP 429, HTTP 504, too many requests, gateway timeout, ETIMEDOUT,
//     ECONNRESET, EAI_AGAIN, fetch failed, network error, timeout
//   • HTTP 503 / Service Unavailable (added for anti-spiral protection)
//   • AbortError / TimeoutError / "operation was aborted" (fetch AbortSignal.timeout)
export const RETRYABLE_TRANSIENT_ERROR_PATTERN =
  /(OPERATION_TIME_LIMIT|QUERY_LIMIT_EXCEEDED|HTTP 429|HTTP 503|HTTP 504|too many requests|Service Unavailable|gateway timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network error|timeout|TimeoutError|AbortError|operation was aborted)/i;

/**
 * Returns true when the error message matches a known transient/retriable
 * Bitrix or network error.
 *
 * @param {Error|string|null|undefined} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  return RETRYABLE_TRANSIENT_ERROR_PATTERN.test(String(error?.message ?? error ?? ''));
}
