import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createDiagRouter } from '../src/diag/diagRoutes.js';
import { DIAG_SIGNATURE_ONLY_PATHS } from '../src/diag/diagMiddleware.js';

// verifyToken.js captures process.env.JWT_SECRET at module load — pin it
// BEFORE importing, same precedent as tests/verifyToken.test.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const { createVerifyToken, createVerifyTokenSignatureOnly } = await import('../utils/verifyToken.js');

const JWT_SECRET = process.env.JWT_SECRET;
const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * S1 (ревью): /ping и /echo измеряют канал оператора, а не нашу БД, но
 * полный verifyToken делает await authContextStore.getContextByKey(...) на
 * каждый запрос — с БД-стором это поход в БД, и зависшая БД вешает оба
 * зонда вместе с собой. Этот файл воспроизводит РЕАЛЬНУЮ мидлварь-развилку
 * server.js (не копию: verifyToken/verifyTokenSignatureOnly и
 * DIAG_SIGNATURE_ONLY_PATHS импортированы, а не переписаны заново), чтобы
 * доказать: /ping отклоняет плохой токен и не ждёт зависший authContextStore.
 */
const buildApp = ({ authContextStore }) => {
  const app = express();
  const verifyToken = createVerifyToken({ authContextStore });
  const verifyTokenSignatureOnly = createVerifyTokenSignatureOnly();
  const signatureOnlyPaths = new Set(DIAG_SIGNATURE_ONLY_PATHS);

  // Та же развилка по req.path, что и в server.js: диагностический роутер
  // монтируется единожды на '/api/diag', Express обрезает префикс, и внутри
  // req.path уже относительный ('/ping', '/echo', ...).
  app.use('/api/diag', (req, res, next) => {
    if (signatureOnlyPaths.has(req.path)) return verifyTokenSignatureOnly(req, res, next);
    return verifyToken(req, res, next);
  }, createDiagRouter({ store: null, logger: silentLogger }));

  return app.listen(0);
};

const call = async (server, path, init) => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, json };
};

const validToken = () => jwt.sign({
  sub: 11, domain: 'nfr-mainsoft.bitrix24.ru', member_id: 'm1'
}, JWT_SECRET, { expiresIn: '1h' });

/** authContextStore, чей getContextByKey никогда не разрешается — та же
 *  форма зависшей БД, которую S1 обязан не пускать на /ping и /echo. */
const hangingAuthContextStore = {
  getContextByKey() {
    return new Promise(() => { /* нарочно никогда не разрешается */ });
  }
};

test('GET /ping: валидный токен — 200, зависший authContextStore НЕ задерживает ответ', async () => {
  const server = buildApp({ authContextStore: hangingAuthContextStore });
  try {
    // Гонка с коротким таймером — конкретное поведенческое доказательство:
    // если бы /ping всё же пошёл в authContextStore.getContextByKey(),
    // fetch() завис бы вместе с ним, и таймер выиграл бы гонку.
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timed-out'), 1000));
    const outcome = await Promise.race([
      call(server, '/api/diag/ping', { headers: { authorization: `Bearer ${validToken()}` } }),
      timeout
    ]);
    assert.notEqual(outcome, 'timed-out', '/ping не должен ждать authContextStore');
    assert.equal(outcome.status, 200);
    assert.equal(typeof outcome.json.t, 'number');
  } finally { server.close(); }
});

test('GET /ping: отсутствующий токен — 401, зависший authContextStore не мешает быстрому отказу', async () => {
  const server = buildApp({ authContextStore: hangingAuthContextStore });
  try {
    const res = await call(server, '/api/diag/ping');
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('GET /ping: неверная подпись токена — 401', async () => {
  const server = buildApp({ authContextStore: hangingAuthContextStore });
  try {
    const badToken = jwt.sign({ sub: 11 }, 'wrong-secret', { expiresIn: '1h' });
    const res = await call(server, '/api/diag/ping', { headers: { authorization: `Bearer ${badToken}` } });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('POST /echo: валидный токен — 200, зависший authContextStore НЕ задерживает ответ', async () => {
  const server = buildApp({ authContextStore: hangingAuthContextStore });
  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timed-out'), 1000));
    const outcome = await Promise.race([
      call(server, '/api/diag/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', authorization: `Bearer ${validToken()}` },
        body: Buffer.alloc(1024, 1)
      }),
      timeout
    ]);
    assert.notEqual(outcome, 'timed-out', '/echo не должен ждать authContextStore');
    assert.equal(outcome.status, 200);
    assert.equal(outcome.json.bytes, 1024);
  } finally { server.close(); }
});

test('POST /echo: отсутствующий токен — 401 (1 МБ тело остаётся за авторизацией)', async () => {
  const server = buildApp({ authContextStore: hangingAuthContextStore });
  try {
    const res = await call(server, '/api/diag/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(1024, 1)
    });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('GET /reports (НЕ в DIAG_SIGNATURE_ONLY_PATHS): валидный токен, но контекст не найден в сторе — 401 через полный verifyToken', async () => {
  // Контрольный тест: доказывает, что развилка по пути реальна — не всё
  // подряд получает сигнатурный гвард, только /ping и /echo. /reports тоже
  // получил бы гейт capabilities.settings (BLOCKING 2) при валидном
  // accessContext, но до этого дело не доходит — полный verifyToken
  // отклоняет запрос раньше (контекста для этого токена в сторе нет).
  const emptyStore = { async getContextByKey() { return null; } };
  const server = buildApp({ authContextStore: emptyStore });
  try {
    const res = await call(server, '/api/diag/reports', { headers: { authorization: `Bearer ${validToken()}` } });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'context_not_found');
  } finally { server.close(); }
});
