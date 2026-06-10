import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientError, RETRYABLE_TRANSIENT_ERROR_PATTERN } from '../src/shared/transientErrors.js';

// Existing transient patterns (from bitrixRestClient.js)
test('isTransientError: QUERY_LIMIT_EXCEEDED → true', () => {
  assert.equal(isTransientError(new Error('QUERY_LIMIT_EXCEEDED')), true);
});

test('isTransientError: OPERATION_TIME_LIMIT → true', () => {
  assert.equal(isTransientError(new Error('OPERATION_TIME_LIMIT')), true);
});

test('isTransientError: HTTP 429 → true', () => {
  assert.equal(isTransientError(new Error('Bitrix REST call failed with HTTP 429')), true);
});

test('isTransientError: HTTP 504 → true', () => {
  assert.equal(isTransientError(new Error('upstream failed HTTP 504')), true);
});

test('isTransientError: ETIMEDOUT → true', () => {
  assert.equal(isTransientError(new Error('ETIMEDOUT')), true);
});

test('isTransientError: ECONNRESET → true', () => {
  assert.equal(isTransientError(new Error('socket hang up ECONNRESET')), true);
});

test('isTransientError: fetch failed → true', () => {
  assert.equal(isTransientError(new Error('fetch failed')), true);
});

// New members: HTTP 503
test('isTransientError: HTTP 503 → true', () => {
  assert.equal(isTransientError(new Error('Bitrix REST failed with HTTP 503')), true);
});

test('isTransientError: Service Unavailable → true', () => {
  assert.equal(isTransientError(new Error('Service Unavailable')), true);
});

// New members: AbortError / TimeoutError
test('isTransientError: TimeoutError → true', () => {
  assert.equal(isTransientError(new Error('TimeoutError: The operation was aborted due to timeout')), true);
});

test('isTransientError: AbortError → true', () => {
  assert.equal(isTransientError(new Error('AbortError')), true);
});

test('isTransientError: "operation was aborted" phrase → true', () => {
  assert.equal(isTransientError(new Error('The operation was aborted due to timeout')), true);
});

// Non-transient: must NOT match
test('isTransientError: ACCESS_DENIED → false', () => {
  assert.equal(isTransientError(new Error('Bitrix REST error: ACCESS_DENIED Доступ запрещен')), false);
});

test('isTransientError: wrong_token → false', () => {
  assert.equal(isTransientError(new Error('wrong_token')), false);
});

test('isTransientError: null/undefined → false', () => {
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError(undefined), false);
});

// Pattern export sanity check
test('RETRYABLE_TRANSIENT_ERROR_PATTERN is a RegExp', () => {
  assert.ok(RETRYABLE_TRANSIENT_ERROR_PATTERN instanceof RegExp);
});
