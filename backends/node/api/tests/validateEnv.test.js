import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequiredEnv } from '../utils/validateEnv.js';

test('validateRequiredEnv: бросает понятную ошибку без JWT_SECRET', () => {
  assert.throws(
    () => validateRequiredEnv({ DB_TYPE: 'postgresql' }),
    /JWT_SECRET/
  );
});

test('validateRequiredEnv: пустая строка считается отсутствующей', () => {
  assert.throws(() => validateRequiredEnv({ JWT_SECRET: '   ' }), /JWT_SECRET/);
});

test('validateRequiredEnv: проходит при заданном JWT_SECRET', () => {
  assert.doesNotThrow(() => validateRequiredEnv({ JWT_SECRET: 'secret' }));
});
