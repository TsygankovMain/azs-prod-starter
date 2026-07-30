import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

// verifyToken.js captures process.env.JWT_SECRET at module load (and the app
// signs JWTs with the same env var). Pin a secret BEFORE importing it so the
// sign side here and the verify side there always agree, even when no .env /
// JWT_SECRET is present in the environment.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const { createVerifyToken, createVerifyTokenSignatureOnly } = await import('../utils/verifyToken.js');

const JWT_SECRET = process.env.JWT_SECRET;

const createRes = () => {
  const state = {
    statusCode: 200,
    payload: null
  };
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.payload = payload;
      return this;
    }
  };
};

test('verifyToken attaches req.user and req.bitrixContext for valid JWT/context', async () => {
  const token = jwt.sign({
    sub: 11,
    domain: 'nfr-mainsoft.bitrix24.ru',
    member_id: 'm1'
  }, JWT_SECRET, { expiresIn: '1h' });

  const req = {
    headers: {
      authorization: `Bearer ${token}`
    }
  };
  const res = createRes();
  let nextCalled = false;

  const middleware = createVerifyToken({
    authContextStore: {
      async getContextByKey() {
        return {
          memberId: 'm1',
          domain: 'nfr-mainsoft.bitrix24.ru',
          userId: 11,
          authId: 'access',
          refreshToken: 'refresh'
        };
      }
    }
  });

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user.user_id, 11);
  assert.equal(req.bitrixContext.userId, 11);
  assert.equal(req.bitrixContext.domain, 'nfr-mainsoft.bitrix24.ru');
});

test('verifyToken returns 401 when context is not found for valid JWT', async () => {
  const token = jwt.sign({
    sub: 11,
    domain: 'nfr-mainsoft.bitrix24.ru',
    member_id: 'm1'
  }, JWT_SECRET, { expiresIn: '1h' });

  const req = {
    headers: {
      authorization: `Bearer ${token}`
    }
  };
  const res = createRes();
  let nextCalled = false;

  const middleware = createVerifyToken({
    authContextStore: {
      async getContextByKey() {
        return null;
      }
    }
  });

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.state.statusCode, 401);
  assert.equal(res.state.payload.error, 'context_not_found');
});

// --- S1 (ревью): createVerifyTokenSignatureOnly — гвард для /ping и /echo,
// который отклоняет невалидный/отсутствующий токен, но не строит
// authContextStore зависимость вовсе (в отличие от createVerifyToken —
// см. server.js: полный гвард дёргает authContextStore.getContextByKey на
// каждый запрос, и с БД-стором это поход в БД на каждый зонд).

test('createVerifyTokenSignatureOnly: валидный JWT — next() и req.user, БЕЗ authContextStore', async () => {
  const token = jwt.sign({
    sub: 11,
    domain: 'nfr-mainsoft.bitrix24.ru',
    member_id: 'm1'
  }, JWT_SECRET, { expiresIn: '1h' });

  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = createRes();
  let nextCalled = false;

  // Сигнатура createVerifyTokenSignatureOnly() не принимает authContextStore
  // вовсе — само отсутствие параметра уже доказывает, что стор не может
  // быть тронут. Гонка ниже — конкретное поведенческое доказательство: даже
  // никогда не разрешающийся промис не задерживает next().
  const middleware = createVerifyTokenSignatureOnly();
  const hang = new Promise(() => { /* нарочно никогда не разрешается */ });

  const outcome = await Promise.race([
    middleware(req, res, () => { nextCalled = true; return 'next-called'; }),
    hang.then(() => 'hung')
  ]);

  assert.notEqual(outcome, 'hung');
  assert.equal(nextCalled, true);
  assert.equal(req.user.user_id, 11);
  assert.equal(req.bitrixContext, undefined);
});

test('createVerifyTokenSignatureOnly: без заголовка Authorization — 401, next() не вызван', async () => {
  const req = { headers: {} };
  const res = createRes();
  let nextCalled = false;

  const middleware = createVerifyTokenSignatureOnly();
  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.state.statusCode, 401);
  assert.equal(res.state.payload.error, 'Authorization header missing');
});

test('createVerifyTokenSignatureOnly: неверная подпись — 401, next() не вызван', async () => {
  const badToken = jwt.sign({ sub: 11 }, 'wrong-secret', { expiresIn: '1h' });
  const req = { headers: { authorization: `Bearer ${badToken}` } };
  const res = createRes();
  let nextCalled = false;

  const middleware = createVerifyTokenSignatureOnly();
  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.state.statusCode, 401);
  assert.equal(res.state.payload.error, 'Invalid or expired token');
});

test('createVerifyTokenSignatureOnly: истёкший токен — 401', async () => {
  const expiredToken = jwt.sign({ sub: 11 }, JWT_SECRET, { expiresIn: -10 });
  const req = { headers: { authorization: `Bearer ${expiredToken}` } };
  const res = createRes();
  let nextCalled = false;

  const middleware = createVerifyTokenSignatureOnly();
  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.state.statusCode, 401);
});

test('createVerifyTokenSignatureOnly: неверный формат заголовка (не Bearer) — 401', async () => {
  const req = { headers: { authorization: 'Basic abc123' } };
  const res = createRes();
  let nextCalled = false;

  const middleware = createVerifyTokenSignatureOnly();
  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.state.statusCode, 401);
  assert.equal(res.state.payload.error, 'Invalid token format');
});

