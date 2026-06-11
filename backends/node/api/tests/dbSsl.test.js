import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePgSslConfig } from '../utils/dbSsl.js';

// ── не задан / false → undefined ────────────────────────────────────────────

test('resolvePgSslConfig: отсутствие DB_SSL → undefined', () => {
  assert.equal(resolvePgSslConfig({}), undefined);
});

test('resolvePgSslConfig: DB_SSL=false → undefined', () => {
  assert.equal(resolvePgSslConfig({ DB_SSL: 'false' }), undefined);
});

test('resolvePgSslConfig: DB_SSL="" → undefined', () => {
  assert.equal(resolvePgSslConfig({ DB_SSL: '' }), undefined);
});

// ── true / require → rejectUnauthorized: false ────────────────────────────

test('resolvePgSslConfig: DB_SSL=true → {rejectUnauthorized:false}', () => {
  const result = resolvePgSslConfig({ DB_SSL: 'true' });
  assert.deepEqual(result, { rejectUnauthorized: false });
});

test('resolvePgSslConfig: DB_SSL=require → {rejectUnauthorized:false}', () => {
  const result = resolvePgSslConfig({ DB_SSL: 'require' });
  assert.deepEqual(result, { rejectUnauthorized: false });
});

test('resolvePgSslConfig: DB_SSL=TRUE (регистр) → {rejectUnauthorized:false}', () => {
  const result = resolvePgSslConfig({ DB_SSL: 'TRUE' });
  assert.deepEqual(result, { rejectUnauthorized: false });
});

// ── verify-full + DB_SSL_CA_CONTENT ─────────────────────────────────────────

test('resolvePgSslConfig: verify-full + DB_SSL_CA_CONTENT → объект с ca', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----';
  const result = resolvePgSslConfig({ DB_SSL: 'verify-full', DB_SSL_CA_CONTENT: pem });
  assert.deepEqual(result, { rejectUnauthorized: true, ca: pem });
});

// ── verify-full + DB_SSL_CA (файл) ──────────────────────────────────────────

test('resolvePgSslConfig: verify-full + DB_SSL_CA (файл) → объект с ca', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nFILE_PEM\n-----END CERTIFICATE-----\n';
  const caPath = join(tmpdir(), `dbSsl-test-${process.pid}.pem`);
  writeFileSync(caPath, pem, 'utf8');
  try {
    const result = resolvePgSslConfig({ DB_SSL: 'verify-full', DB_SSL_CA: caPath });
    assert.deepEqual(result, { rejectUnauthorized: true, ca: pem });
  } finally {
    unlinkSync(caPath);
  }
});

// ── DB_SSL_CA_CONTENT имеет приоритет перед DB_SSL_CA ─────────────────────

test('resolvePgSslConfig: DB_SSL_CA_CONTENT приоритетнее DB_SSL_CA', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nCONTENT_PEM\n-----END CERTIFICATE-----';
  const result = resolvePgSslConfig({
    DB_SSL: 'verify-full',
    DB_SSL_CA_CONTENT: pem,
    DB_SSL_CA: '/non/existent/path.pem'
  });
  assert.deepEqual(result, { rejectUnauthorized: true, ca: pem });
});

// ── verify-full без CA → понятная ошибка ────────────────────────────────────

test('resolvePgSslConfig: verify-full без CA → Error с объяснением', () => {
  assert.throws(
    () => resolvePgSslConfig({ DB_SSL: 'verify-full' }),
    /DB_SSL=verify-full requires a CA certificate/
  );
});

// ── неизвестное значение → ошибка ──────────────────────────────────────────

test('resolvePgSslConfig: неизвестное значение → Error', () => {
  assert.throws(
    () => resolvePgSslConfig({ DB_SSL: 'on' }),
    /Unknown DB_SSL value/
  );
});
