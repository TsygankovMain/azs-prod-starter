import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

// verifyToken.js captures process.env.JWT_SECRET at module load (and the app
// signs JWTs with the same env var). Pin a secret BEFORE importing it so the
// sign side here and the verify side there always agree, even when no .env /
// JWT_SECRET is present in the environment.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const { createVerifyToken } = await import('../utils/verifyToken.js');

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

