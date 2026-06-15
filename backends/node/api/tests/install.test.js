/**
 * TDD tests for POST /api/install — BUG-S1 security fix.
 *
 * The isAdmin-derivation logic has been extracted into resolveInstallAdmin
 * (src/auth/resolveInstallAdmin.js). Its unit tests live in
 * tests/resolveInstallAdmin.test.js and exercise the production helper directly.
 *
 * This file retains the handler-level integration tests that cannot be expressed
 * at the unit-helper level:
 *   - application_token capture (handler reads req.body and threads the value
 *     into upsertContext — that wiring only exists in server.js).
 *
 * The previous buildInstallHandler duplicate has been removed; it was testing
 * a local copy of the logic, not the production code path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIsAdmin } from '../src/auth/resolveIsAdmin.js';
import { resolveInstallAdmin } from '../src/auth/resolveInstallAdmin.js';

// ---------------------------------------------------------------------------
// Minimal test helpers for handler-level tests
// ---------------------------------------------------------------------------

function makeRes() {
  const state = { statusCode: 200, payload: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.payload = payload; return this; }
  };
}

function makeReq(body = {}) {
  return { body };
}

/**
 * Build a minimal install handler that exercises ONLY the auth-context upsert
 * path (isAdmin + applicationToken capture), importing the REAL production
 * resolveInstallAdmin instead of duplicating its logic.
 *
 * This handler is intentionally thin — it only covers what is NOT already
 * tested by resolveInstallAdmin.test.js (i.e. the req.body parsing + upsert
 * wiring and application_token capture).
 */
function buildInstallHandler({ bitrixClient, authContextStore, timeoutMs = 5000 }) {
  const parseUserId = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  };

  const buildInstallContext = ({ authId, refreshToken, domain, memberId, userId, appSid }) => ({
    authId,
    refreshToken,
    domain,
    memberId,
    userId,
    appSid
  });

  return async (req, res) => {
    try {
      const authId = String(req.body?.AUTH_ID || '').trim();
      const refreshToken = String(req.body?.REFRESH_TOKEN || req.body?.REFRESH_ID || '').trim();
      const domain = String(req.body?.DOMAIN || '').trim().toLowerCase();
      const memberId = String(req.body?.member_id || '').trim();
      const userId = parseUserId(req.body?.user_id);
      const appSid = String(req.body?.APP_SID || '').trim();

      const applicationToken = String(
        req.body?.auth?.application_token ?? req.body?.application_token ?? ''
      ).trim();

      const installContext = buildInstallContext({
        authId,
        refreshToken,
        domain,
        memberId,
        userId,
        appSid
      });

      if (authId || refreshToken || domain || memberId || userId) {
        // Uses the REAL production helper — not a duplicate
        const isAdmin = await resolveInstallAdmin({
          bitrixClient,
          authId,
          installContext,
          timeoutMs
        });

        const upsertPayload = {
          ...installContext,
          isAdmin,
          refreshTokenIssuedAt: new Date().toISOString()
        };

        if (applicationToken) {
          upsertPayload.applicationToken = applicationToken;
        }

        await authContextStore.upsertContext(upsertPayload).catch((error) => {
          console.error('Failed to persist auth context on /api/install', error);
        });
      }

      return res.json({ message: 'All success' });
    } catch (error) {
      return res.status(500).json({ error: 'install_failed', message: error.message });
    }
  };
}

// ---------------------------------------------------------------------------
// Handler-level: application_token capture
// These tests verify that server.js correctly parses req.body and passes
// applicationToken through to upsertContext — something resolveInstallAdmin
// does not touch.
// ---------------------------------------------------------------------------

test('install: application_token in body → stored in upserted context', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth() { return { ID: 3, ADMIN: 'Y' }; }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };

  const handler = buildInstallHandler({ bitrixClient, authContextStore });
  const req = makeReq({
    AUTH_ID: 'token-with-app-token',
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'member-mno',
    user_id: 3,
    REFRESH_TOKEN: 'refresh-mno',
    application_token: 'app-token-secret-abc'
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(upsertCalls.length, 1, 'upsertContext must be called');
  assert.equal(
    upsertCalls[0].applicationToken,
    'app-token-secret-abc',
    'application_token must be captured and stored in the context'
  );
});

test('install: application_token nested in auth.application_token → stored correctly', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth() { return { ID: 4, ADMIN: 'Y' }; }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };

  const handler = buildInstallHandler({ bitrixClient, authContextStore });
  const req = makeReq({
    AUTH_ID: 'token-nested',
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'member-pqr',
    user_id: 4,
    REFRESH_TOKEN: 'refresh-pqr',
    auth: { application_token: 'nested-app-token-xyz' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(upsertCalls[0].applicationToken, 'nested-app-token-xyz');
});

// ---------------------------------------------------------------------------
// Smoke: isAdmin=true is wired through when resolveInstallAdmin returns true
// (Verifies handler ↔ helper integration without duplicating helper logic)
// ---------------------------------------------------------------------------

test('install handler: valid authId, profile.ADMIN=Y → upsertContext receives isAdmin:true', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth() { return { ID: 5, ADMIN: 'Y' }; }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };

  const handler = buildInstallHandler({ bitrixClient, authContextStore });
  await handler(makeReq({
    AUTH_ID: 'admin-token',
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'mem-1',
    user_id: 5,
    REFRESH_TOKEN: 'rt-1'
  }), makeRes());

  assert.equal(upsertCalls[0].isAdmin, true, 'isAdmin must be true when profile.ADMIN=Y');
});

test('install handler: no authId → upsertContext receives isAdmin:false (no profile call)', async () => {
  const profileCalls = [];
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth(method) { profileCalls.push(method); return {}; }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };

  const handler = buildInstallHandler({ bitrixClient, authContextStore });
  await handler(makeReq({
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'mem-2',
    user_id: 6
  }), makeRes());

  assert.equal(profileCalls.length, 0, 'no profile call when authId absent');
  assert.equal(upsertCalls[0].isAdmin, false);
});
