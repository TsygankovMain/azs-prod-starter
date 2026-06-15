/**
 * Unit tests for checkBotEventSecret (src/security/botEventGate.js).
 *
 * These tests exercise the REAL production gate function, not a local
 * inline duplicate. This is the authoritative gate test — botEventSecurity.test.js
 * tests the integration-level route behaviour (handler wiring, stubbed stores, etc.).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBotEventSecret } from '../src/security/botEventGate.js';

// ─── no-secret: JOB_SECRET unset / empty / whitespace ────────────────────────

test('checkBotEventSecret: undefined jobSecret → no-secret', () => {
  assert.equal(checkBotEventSecret(undefined, 'anything'), 'no-secret');
});

test('checkBotEventSecret: null jobSecret → no-secret', () => {
  assert.equal(checkBotEventSecret(null, 'anything'), 'no-secret');
});

test('checkBotEventSecret: empty string jobSecret → no-secret', () => {
  assert.equal(checkBotEventSecret('', 'anything'), 'no-secret');
});

test('checkBotEventSecret: whitespace-only jobSecret → no-secret', () => {
  assert.equal(checkBotEventSecret('   ', 'anything'), 'no-secret');
});

test('checkBotEventSecret: whitespace-only jobSecret, no providedSecret → no-secret', () => {
  assert.equal(checkBotEventSecret('   ', undefined), 'no-secret');
});

// ─── ok: jobSecret set and providedSecret matches ─────────────────────────────

test('checkBotEventSecret: matching secrets → ok', () => {
  assert.equal(checkBotEventSecret('mysecret', 'mysecret'), 'ok');
});

test('checkBotEventSecret: jobSecret with surrounding whitespace stripped, matching → ok', () => {
  // Env vars can have accidental whitespace; gate must trim before comparing.
  assert.equal(checkBotEventSecret('  mysecret  ', 'mysecret'), 'ok');
});

// ─── reject: jobSecret set but providedSecret wrong or absent ─────────────────

test('checkBotEventSecret: wrong providedSecret → reject', () => {
  assert.equal(checkBotEventSecret('mysecret', 'wrongsecret'), 'reject');
});

test('checkBotEventSecret: undefined providedSecret → reject', () => {
  assert.equal(checkBotEventSecret('mysecret', undefined), 'reject');
});

test('checkBotEventSecret: empty providedSecret → reject', () => {
  assert.equal(checkBotEventSecret('mysecret', ''), 'reject');
});

test('checkBotEventSecret: null providedSecret → reject', () => {
  assert.equal(checkBotEventSecret('mysecret', null), 'reject');
});

test('checkBotEventSecret: providedSecret is close but not equal → reject', () => {
  assert.equal(checkBotEventSecret('abc123', 'abc124'), 'reject');
});
