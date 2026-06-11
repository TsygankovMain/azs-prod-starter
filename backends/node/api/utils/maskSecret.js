/**
 * maskSecret — helpers to prevent raw OAuth tokens from leaking into logs.
 *
 * maskSecret(value):
 *   - null / undefined / empty string → '∅'
 *   - 1–6 chars → returns as-is (too short to gain anything from masking)
 *   - 7+ chars → first 6 chars + '…' + total length  e.g. 'abc123…42'
 *
 * maskAuthFields(obj):
 *   Shallow-copies obj, replacing the values of known sensitive keys with
 *   their masked form. Key matching is case-insensitive.
 *   Sensitive keys: AUTH_ID, REFRESH_TOKEN, auth_id, refresh_token, authId,
 *   refreshToken, access_token, password, client_secret.
 */

const SENSITIVE_KEYS = new Set([
  'auth_id',
  'refresh_token',
  'authid',
  'refreshtoken',
  'access_token',
  'password',
  'client_secret'
]);

/**
 * Masks a secret string value for safe logging.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function maskSecret(value) {
  if (value === null || value === undefined || value === '') {
    return '∅';
  }
  const str = String(value);
  if (str.length <= 6) {
    return str;
  }
  return `${str.slice(0, 6)}…${str.length}`;
}

/**
 * Returns a shallow copy of `obj` with all sensitive fields replaced by their
 * masked values. Non-object / array inputs are returned unchanged.
 *
 * @param {object|null|undefined} obj
 * @returns {object|null|undefined}
 */
export function maskAuthFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = maskSecret(result[key]);
    }
  }
  return result;
}
