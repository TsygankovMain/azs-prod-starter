import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret, maskAuthFields } from '../utils/maskSecret.js';

// ---------------------------------------------------------------------------
// maskSecret
// ---------------------------------------------------------------------------

test('maskSecret: empty string → ∅', () => {
  assert.equal(maskSecret(''), '∅');
});

test('maskSecret: null → ∅', () => {
  assert.equal(maskSecret(null), '∅');
});

test('maskSecret: undefined → ∅', () => {
  assert.equal(maskSecret(undefined), '∅');
});

test('maskSecret: string of 1 char is returned as-is', () => {
  assert.equal(maskSecret('a'), 'a');
});

test('maskSecret: string of exactly 6 chars is returned as-is', () => {
  assert.equal(maskSecret('abc123'), 'abc123');
});

test('maskSecret: string of 7 chars is masked', () => {
  // 'abc1234' → first 6 = 'abc123' + '…' + 7
  assert.equal(maskSecret('abc1234'), 'abc123…7');
});

test('maskSecret: long OAuth token is masked with correct prefix and length', () => {
  const token = 'a'.repeat(40);
  const result = maskSecret(token);
  assert.equal(result, 'aaaaaa…40');
});

test('maskSecret: non-string truthy value is coerced to string first', () => {
  // Number 1234567 → '1234567' (length 7)
  assert.equal(maskSecret(1234567), '123456…7');
});

// ---------------------------------------------------------------------------
// maskAuthFields
// ---------------------------------------------------------------------------

test('maskAuthFields: masks AUTH_ID key (uppercase)', () => {
  const obj = { AUTH_ID: 'supersecrettoken123', domain: 'example.bitrix24.ru' };
  const result = maskAuthFields(obj);
  assert.equal(result.AUTH_ID, 'supers…19');
  assert.equal(result.domain, 'example.bitrix24.ru');
});

test('maskAuthFields: masks REFRESH_TOKEN key (uppercase)', () => {
  const obj = { REFRESH_TOKEN: 'refreshvalue999' };
  const result = maskAuthFields(obj);
  assert.equal(result.REFRESH_TOKEN, 'refres…15');
});

test('maskAuthFields: masks authId (camelCase)', () => {
  const obj = { authId: 'camelcasetoken' };
  const result = maskAuthFields(obj);
  assert.equal(result.authId, 'camelc…14');
});

test('maskAuthFields: masks refreshToken (camelCase)', () => {
  const obj = { refreshToken: 'longrefreshtoken' };
  const result = maskAuthFields(obj);
  assert.equal(result.refreshToken, 'longre…16');
});

test('maskAuthFields: masks access_token', () => {
  const obj = { access_token: 'myaccesstoken!' };
  const result = maskAuthFields(obj);
  assert.equal(result.access_token, 'myacce…14');
});

test('maskAuthFields: masks password', () => {
  const obj = { password: 'secret' };
  const result = maskAuthFields(obj);
  // 'secret' is exactly 6 chars → returned as-is (not enough to mask)
  assert.equal(result.password, 'secret');
});

test('maskAuthFields: masks client_secret', () => {
  const obj = { client_secret: 'mysupersecretvalue' };
  const result = maskAuthFields(obj);
  assert.equal(result.client_secret, 'mysuper'.slice(0, 6) + '…18');
});

test('maskAuthFields: non-sensitive keys are NOT masked', () => {
  const obj = { domain: 'portal.bitrix24.ru', memberId: 'abc', userId: 42 };
  const result = maskAuthFields(obj);
  assert.deepEqual(result, obj);
});

test('maskAuthFields: does not mutate the original object', () => {
  const original = { AUTH_ID: 'original_token', domain: 'test' };
  const copy = { ...original };
  maskAuthFields(original);
  assert.deepEqual(original, copy, 'original object must not be mutated');
});

test('maskAuthFields: returns non-object inputs unchanged (null)', () => {
  assert.equal(maskAuthFields(null), null);
});

test('maskAuthFields: returns non-object inputs unchanged (string)', () => {
  assert.equal(maskAuthFields('raw string'), 'raw string');
});

test('maskAuthFields: returns array input unchanged', () => {
  const arr = [1, 2, 3];
  assert.equal(maskAuthFields(arr), arr);
});

test('maskAuthFields: empty token value is masked as ∅', () => {
  const obj = { AUTH_ID: '' };
  const result = maskAuthFields(obj);
  assert.equal(result.AUTH_ID, '∅');
});

// ---------------------------------------------------------------------------
// Hot-path integration: getToken-style body
// ---------------------------------------------------------------------------

test('maskAuthFields: typical /api/getToken body hides tokens but keeps safe fields', () => {
  const body = {
    AUTH_ID: 'longauthidvalue123456',
    REFRESH_TOKEN: 'longrefreshidvalue123456',
    DOMAIN: 'portal.example.bitrix24.ru',
    member_id: 'abc123',
    user_id: 42,
    APP_SID: 'sid001'
  };
  const result = maskAuthFields(body);
  // Sensitive
  assert.ok(result.AUTH_ID.includes('…'), 'AUTH_ID must be masked');
  assert.ok(result.REFRESH_TOKEN.includes('…'), 'REFRESH_TOKEN must be masked');
  // Safe
  assert.equal(result.DOMAIN, 'portal.example.bitrix24.ru');
  assert.equal(result.member_id, 'abc123');
  assert.equal(result.user_id, 42);
  assert.equal(result.APP_SID, 'sid001');
});
