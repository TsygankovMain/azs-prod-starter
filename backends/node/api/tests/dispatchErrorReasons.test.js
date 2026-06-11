import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDispatchError } from '../src/reports/dispatchErrorReasons.js';
import { NOTIFY_FALLBACK_PREFIX } from '../src/notifications/notificationService.js';

// ── NOTIFY_FALLBACK ───────────────────────────────────────────────────────────

test('classifyDispatchError: NOTIFY_FALLBACK for errorText starting with NOTIFY_FALLBACK_PREFIX', () => {
  const result = classifyDispatchError(`${NOTIFY_FALLBACK_PREFIX}some bot error here`);
  assert.deepEqual(result, { reasonCode: 'NOTIFY_FALLBACK', isFallback: true });
});

test('classifyDispatchError: NOTIFY_FALLBACK uses imported prefix (not a hardcoded string)', () => {
  // If the prefix constant changes, both sides update together.
  const result = classifyDispatchError(NOTIFY_FALLBACK_PREFIX + 'PARAM_KEYBOARD');
  assert.equal(result.reasonCode, 'NOTIFY_FALLBACK');
  assert.equal(result.isFallback, true);
});

// ── NO_AUTH_CONTEXT ───────────────────────────────────────────────────────────

test('classifyDispatchError: NO_AUTH_CONTEXT for "no auth context"', () => {
  const result = classifyDispatchError('skipped: no auth context at send time');
  assert.deepEqual(result, { reasonCode: 'NO_AUTH_CONTEXT', isFallback: false });
});

test('classifyDispatchError: NO_AUTH_CONTEXT is case-insensitive', () => {
  assert.equal(classifyDispatchError('No Auth Context').reasonCode, 'NO_AUTH_CONTEXT');
});

// ── OAUTH_REFRESH_FAILED ──────────────────────────────────────────────────────

test('classifyDispatchError: OAUTH_REFRESH_FAILED for "wrong_client"', () => {
  const result = classifyDispatchError('token refresh error: wrong_client');
  assert.deepEqual(result, { reasonCode: 'OAUTH_REFRESH_FAILED', isFallback: false });
});

test('classifyDispatchError: OAUTH_REFRESH_FAILED for "refresh failed"', () => {
  const result = classifyDispatchError('OAuth refresh failed: invalid credentials');
  assert.deepEqual(result, { reasonCode: 'OAUTH_REFRESH_FAILED', isFallback: false });
});

// ── KEYBOARD_REJECTED ─────────────────────────────────────────────────────────

test('classifyDispatchError: KEYBOARD_REJECTED for PARAM_KEYBOARD', () => {
  const result = classifyDispatchError('Bitrix error: PARAM_KEYBOARD_ERROR');
  assert.deepEqual(result, { reasonCode: 'KEYBOARD_REJECTED', isFallback: false });
});

test('classifyDispatchError: KEYBOARD_REJECTED is case-insensitive', () => {
  assert.equal(classifyDispatchError('param_keyboard invalid').reasonCode, 'KEYBOARD_REJECTED');
});

// ── BOT_MISSING ───────────────────────────────────────────────────────────────

test('classifyDispatchError: BOT_MISSING for BOT_ID in error text', () => {
  const result = classifyDispatchError('BITRIX_BOT_ID is required when BITRIX_BOT_MODE=bot');
  assert.deepEqual(result, { reasonCode: 'BOT_MISSING', isFallback: false });
});

test('classifyDispatchError: BOT_MISSING for "bot not found"', () => {
  const result = classifyDispatchError('bot not found on portal');
  assert.deepEqual(result, { reasonCode: 'BOT_MISSING', isFallback: false });
});

// ── BITRIX_5XX ────────────────────────────────────────────────────────────────

test('classifyDispatchError: BITRIX_5XX for "HTTP 5" prefix', () => {
  const result = classifyDispatchError('request failed: HTTP 503 Service Unavailable');
  assert.deepEqual(result, { reasonCode: 'BITRIX_5XX', isFallback: false });
});

test('classifyDispatchError: BITRIX_5XX for "timeout"', () => {
  const result = classifyDispatchError('connection timeout after 30000ms');
  assert.deepEqual(result, { reasonCode: 'BITRIX_5XX', isFallback: false });
});

test('classifyDispatchError: BITRIX_5XX for "ETIMEDOUT"', () => {
  const result = classifyDispatchError('ETIMEDOUT: connect ETIMEDOUT 192.168.1.1:443');
  assert.deepEqual(result, { reasonCode: 'BITRIX_5XX', isFallback: false });
});

// ── UNKNOWN ───────────────────────────────────────────────────────────────────

test('classifyDispatchError: UNKNOWN for unrecognised error text', () => {
  const result = classifyDispatchError('some completely unknown error XYZ');
  assert.deepEqual(result, { reasonCode: 'UNKNOWN', isFallback: false });
});

test('classifyDispatchError: UNKNOWN for null input', () => {
  const result = classifyDispatchError(null);
  assert.deepEqual(result, { reasonCode: 'UNKNOWN', isFallback: false });
});

test('classifyDispatchError: UNKNOWN for empty string', () => {
  const result = classifyDispatchError('');
  assert.deepEqual(result, { reasonCode: 'UNKNOWN', isFallback: false });
});

test('classifyDispatchError: UNKNOWN for undefined input', () => {
  const result = classifyDispatchError(undefined);
  assert.deepEqual(result, { reasonCode: 'UNKNOWN', isFallback: false });
});

// ── Priority: NOTIFY_FALLBACK wins over other patterns ────────────────────────

test('classifyDispatchError: NOTIFY_FALLBACK takes priority over NO_AUTH_CONTEXT when prefix matches', () => {
  const text = `${NOTIFY_FALLBACK_PREFIX}no auth context at send time`;
  const result = classifyDispatchError(text);
  assert.equal(result.reasonCode, 'NOTIFY_FALLBACK');
  assert.equal(result.isFallback, true);
});
