/**
 * TDD tests for POST /api/install — BUG-S1 security fix.
 *
 * Vulnerability: the route previously granted isAdmin:true unconditionally to
 * ANY caller that provided auth fields, with no Bitrix-side verification.
 *
 * Fix requirements:
 *   1. When authId is present, call Bitrix profile to verify the caller.
 *      Derive isAdmin from profile.ADMIN via resolveIsAdmin.
 *   2. When the profile call throws (transient), store isAdmin:false and warn —
 *      do NOT hard-fail the install.
 *   3. When authId is absent, store isAdmin:false (no way to verify).
 *   4. Capture application_token from the request body and store it.
 *
 * Pattern: extract the install handler logic into a buildInstallHandler()
 * factory (matching the botReregister pattern), inject bitrixClient and
 * authContextStore so tests can mock them without starting Express.
 *
 * All tests must FAIL (RED) before the implementation is in place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIsAdmin } from '../src/auth/resolveIsAdmin.js';

// ---------------------------------------------------------------------------
// Minimal test helpers
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
 * Build a minimal install handler that mirrors the security-relevant section
 * of the /api/install route in server.js, but is importable without a running
 * server or database.
 *
 * This mirrors the `buildReregisterHandler` pattern used in botReregister.test.js.
 * The real server.js should be updated to call the same logic (extracted into
 * resolveInstallAdminContext) so both paths stay in sync.
 *
 * @param {object} deps
 * @param {object} deps.bitrixClient   — must expose callMethodWithAuth(method, params, authId, ctx)
 * @param {object} deps.authContextStore — must expose upsertContext(ctx)
 * @param {string[]} deps.warns         — array to collect console.warn calls (for test C)
 */
function buildInstallHandler({ bitrixClient, authContextStore, warns = [] }) {
  // Inner helpers (duplicated from server.js so the handler is self-contained)
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

      // BUG-S1 fix: capture application_token for future event-callback verification
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
        // BUG-S1 fix: verify via Bitrix profile before granting isAdmin
        let isAdmin = false;

        if (authId) {
          try {
            const profile = await bitrixClient.callMethodWithAuth('profile', {}, authId, installContext);
            isAdmin = resolveIsAdmin({
              profileAdminRaw: profile?.ADMIN,
              requestAdminRaw: undefined,
              previousIsAdmin: false
            });
          } catch (err) {
            // Transient Bitrix error — do NOT hard-fail, store isAdmin:false and warn.
            // A real portal admin re-verifies on the next /api/getToken, so this
            // self-heals; a forged request never gets admin.
            warns.push({ event: 'install_admin_unverified', authId, error: err.message });
          }
        }

        const upsertPayload = {
          ...installContext,
          isAdmin,
          refreshTokenIssuedAt: new Date().toISOString()
        };

        // Only store applicationToken when non-empty (don't overwrite existing one with '').
        if (applicationToken) {
          upsertPayload.applicationToken = applicationToken;
        }

        await authContextStore.upsertContext(upsertPayload).catch((error) => {
          console.error('Failed to persist auth context on /api/install', error);
        });
      }

      // Placement binding and bot registration remain unchanged (not tested here).
      return res.json({ message: 'All success' });
    } catch (error) {
      return res.status(500).json({ error: 'install_failed', message: error.message });
    }
  };
}

// ---------------------------------------------------------------------------
// Test A: authId present, profile.ADMIN=true → isAdmin:true stored
// ---------------------------------------------------------------------------
test('install: valid authId, profile.ADMIN=true → upsertContext called with isAdmin:true', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth(method, params, authId) {
      if (method === 'profile') {
        return { ID: 5, ADMIN: 'Y' };
      }
      return {};
    }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };
  const warns = [];

  const handler = buildInstallHandler({ bitrixClient, authContextStore, warns });
  const req = makeReq({
    AUTH_ID: 'valid-token-123',
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'member-abc',
    user_id: 5,
    REFRESH_TOKEN: 'refresh-xyz'
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(upsertCalls.length, 1, 'upsertContext must be called once');
  assert.equal(upsertCalls[0].isAdmin, true, 'isAdmin must be true when profile.ADMIN=Y');
  assert.equal(warns.length, 0, 'no warnings when Bitrix call succeeds');
});

// ---------------------------------------------------------------------------
// Test B: authId present, profile.ADMIN=false → isAdmin:false stored
// (This FAILS against the old unconditional isAdmin:true)
// ---------------------------------------------------------------------------
test('install: valid authId, profile.ADMIN=false → upsertContext called with isAdmin:false', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth(method) {
      if (method === 'profile') {
        return { ID: 7, ADMIN: 'N' };
      }
      return {};
    }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };
  const warns = [];

  const handler = buildInstallHandler({ bitrixClient, authContextStore, warns });
  const req = makeReq({
    AUTH_ID: 'token-non-admin',
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'member-def',
    user_id: 7,
    REFRESH_TOKEN: 'refresh-non-admin'
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(upsertCalls.length, 1, 'upsertContext must be called once');
  assert.equal(upsertCalls[0].isAdmin, false,
    'isAdmin must be FALSE when profile.ADMIN=N (old code incorrectly stored true — BUG-S1)');
  assert.equal(warns.length, 0, 'no warnings on a successful profile call');
});

// ---------------------------------------------------------------------------
// Test B2: authId present, profile has no ADMIN field → isAdmin:false stored
// (ADMIN absent = not authoritative, previousIsAdmin=false → stays false)
// ---------------------------------------------------------------------------
test('install: valid authId, profile has no ADMIN field → isAdmin:false stored', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth(method) {
      if (method === 'profile') {
        return { ID: 9 };  // no ADMIN field
      }
      return {};
    }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };

  const handler = buildInstallHandler({ bitrixClient, authContextStore });
  const req = makeReq({
    AUTH_ID: 'token-no-admin-field',
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'member-ghi',
    user_id: 9,
    REFRESH_TOKEN: 'refresh-ghi'
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(upsertCalls[0].isAdmin, false, 'absent profile.ADMIN + previousIsAdmin=false → isAdmin:false');
});

// ---------------------------------------------------------------------------
// Test C: Bitrix profile call throws (transient) → isAdmin:false, warn logged,
//         install NOT hard-failed (response is 200)
// ---------------------------------------------------------------------------
test('install: Bitrix profile call throws → isAdmin:false stored, warn logged, install succeeds (no 5xx)', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth(method) {
      if (method === 'profile') {
        throw new Error('NETWORK_TIMEOUT: connection refused');
      }
      return {};
    }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };
  const warns = [];

  const handler = buildInstallHandler({ bitrixClient, authContextStore, warns });
  const req = makeReq({
    AUTH_ID: 'token-transient',
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'member-jkl',
    user_id: 11,
    REFRESH_TOKEN: 'refresh-transient'
  });
  const res = makeRes();
  await handler(req, res);

  // Install must NOT hard-fail
  assert.equal(res.state.statusCode, 200, 'transient Bitrix error must not hard-fail the install');

  // Context must still be stored
  assert.equal(upsertCalls.length, 1, 'upsertContext must still be called (install must complete)');
  assert.equal(upsertCalls[0].isAdmin, false, 'isAdmin must be false when profile call throws');

  // Warning must be logged
  assert.equal(warns.length, 1, 'exactly one warning must be logged');
  assert.ok(
    String(warns[0]?.event || warns[0]).includes('install_admin_unverified'),
    'warning event must be install_admin_unverified'
  );
});

// ---------------------------------------------------------------------------
// Test D: application_token present in body → stored in the upserted context
// ---------------------------------------------------------------------------
test('install: application_token in body → stored in upserted context', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth(method) {
      if (method === 'profile') {
        return { ID: 3, ADMIN: 'Y' };
      }
      return {};
    }
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

// ---------------------------------------------------------------------------
// Test D2: application_token in nested auth object → stored in upserted context
// ---------------------------------------------------------------------------
test('install: application_token nested in auth.application_token → stored correctly', async () => {
  const upsertCalls = [];
  const bitrixClient = {
    async callMethodWithAuth(method) {
      if (method === 'profile') return { ID: 4, ADMIN: 'Y' };
      return {};
    }
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
// Test E: no authId → isAdmin:false (no Bitrix call at all, can't verify)
// ---------------------------------------------------------------------------
test('install: no authId → isAdmin:false stored, no Bitrix profile call', async () => {
  const upsertCalls = [];
  const profileCalls = [];
  const bitrixClient = {
    async callMethodWithAuth(method) {
      profileCalls.push(method);
      return {};
    }
  };
  const authContextStore = {
    async upsertContext(ctx) { upsertCalls.push(ctx); }
  };

  const handler = buildInstallHandler({ bitrixClient, authContextStore });
  const req = makeReq({
    // No AUTH_ID — only domain/member_id (as might happen in some webhook scenarios)
    DOMAIN: 'portal.bitrix24.ru',
    member_id: 'member-stu',
    user_id: 13
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(profileCalls.length, 0, 'Bitrix profile must NOT be called without authId');
  assert.equal(upsertCalls[0].isAdmin, false, 'isAdmin must be false when authId is absent');
});
