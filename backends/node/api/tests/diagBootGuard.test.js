import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagStore } from '../src/diag/diagStore.js';

test('createDiagStore отвергает не-PostgreSQL', () => {
  assert.throws(() => createDiagStore({ pool: { query() {} }, dbType: 'mysql' }), /only PostgreSQL/);
});

test('отказ стора не должен ронять старт: try/catch отдаёт null', () => {
  // Повторяет форму защиты из server.js: приложение обязано подняться,
  // потеряв диагностику, а не упасть целиком.
  let diagStore = null;
  let logged = null;
  try {
    diagStore = createDiagStore({ pool: { query() {} }, dbType: 'mysql' });
  } catch (error) {
    logged = error.message;
  }
  assert.equal(diagStore, null);
  assert.match(logged, /only PostgreSQL/);
});

test('на PostgreSQL стор создаётся нормально', () => {
  const store = createDiagStore({ pool: { query() {} }, dbType: 'postgresql' });
  assert.equal(typeof store.ensureSchema, 'function');
  assert.equal(typeof store.insert, 'function');
});
