/**
 * Unit tests for resolveInstallAdmin — BUG-S1 follow-up.
 *
 * This helper is extracted from server.js /api/install so tests exercise
 * production code rather than a duplicate local `buildInstallHandler`.
 *
 * Scenarios:
 *   A. authId falsy        → false, bitrixClient.callMethodWithAuth NOT called.
 *   B1. profile.ADMIN='Y'  → true
 *   B2. profile.ADMIN='N'  → false
 *   B3. profile missing ADMIN field → false
 *   C. profile call rejects → false + logger.warn called with 'install_admin_unverified'
 *   D. profile call hangs > timeoutMs → resolves false quickly (fail-fast)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// This import fails until src/auth/resolveInstallAdmin.js is created — intentional RED.
const { resolveInstallAdmin } = await import('../src/auth/resolveInstallAdmin.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBitrixClient(profileResult) {
  const calls = [];
  return {
    calls,
    callMethodWithAuth: async (method, params, authId, context) => {
      calls.push({ method, authId });
      if (profileResult instanceof Error) throw profileResult;
      if (typeof profileResult === 'function') return profileResult();
      return profileResult;
    }
  };
}

function makeLogger() {
  const warns = [];
  return {
    warns,
    warn: (...args) => warns.push(args)
  };
}

const INSTALL_CTX = { domain: 'portal.example.com', memberId: 'abc', userId: 5 };

// ---------------------------------------------------------------------------
// A. authId absent → false, no profile call
// ---------------------------------------------------------------------------

test('resolveInstallAdmin: authId absent → returns false without calling bitrixClient', async () => {
  const client = makeBitrixClient({ ID: 1, ADMIN: 'Y' });
  const result = await resolveInstallAdmin({
    bitrixClient: client,
    authId: '',
    installContext: INSTALL_CTX
  });
  assert.equal(result, false, 'should return false when authId is empty');
  assert.equal(client.calls.length, 0, 'callMethodWithAuth must not be called without authId');
});

test('resolveInstallAdmin: authId undefined → returns false without calling bitrixClient', async () => {
  const client = makeBitrixClient({ ID: 1, ADMIN: 'Y' });
  const result = await resolveInstallAdmin({
    bitrixClient: client,
    authId: undefined,
    installContext: INSTALL_CTX
  });
  assert.equal(result, false);
  assert.equal(client.calls.length, 0);
});

// ---------------------------------------------------------------------------
// B. profile.ADMIN derivation
// ---------------------------------------------------------------------------

test('resolveInstallAdmin: profile.ADMIN=Y → returns true', async () => {
  const client = makeBitrixClient({ ID: 5, ADMIN: 'Y' });
  const result = await resolveInstallAdmin({
    bitrixClient: client,
    authId: 'valid-token',
    installContext: INSTALL_CTX
  });
  assert.equal(result, true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'profile');
});

test('resolveInstallAdmin: profile.ADMIN=N → returns false', async () => {
  const client = makeBitrixClient({ ID: 7, ADMIN: 'N' });
  const result = await resolveInstallAdmin({
    bitrixClient: client,
    authId: 'token-non-admin',
    installContext: INSTALL_CTX
  });
  assert.equal(result, false);
});

test('resolveInstallAdmin: profile without ADMIN field → returns false', async () => {
  const client = makeBitrixClient({ ID: 9 }); // no ADMIN field
  const result = await resolveInstallAdmin({
    bitrixClient: client,
    authId: 'token-no-admin-field',
    installContext: INSTALL_CTX
  });
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// C. profile call rejects → false + warn logged
// ---------------------------------------------------------------------------

test('resolveInstallAdmin: profile call rejects → returns false, warns with install_admin_unverified', async () => {
  const client = makeBitrixClient(new Error('NETWORK_TIMEOUT: connection refused'));
  const logger = makeLogger();

  const result = await resolveInstallAdmin({
    bitrixClient: client,
    authId: 'token-transient',
    installContext: INSTALL_CTX,
    logger
  });

  assert.equal(result, false, 'must return false on profile call error');
  assert.equal(logger.warns.length, 1, 'exactly one warn must be emitted');
  // First arg is the event name string
  const [warnEvent] = logger.warns[0];
  assert.equal(warnEvent, 'install_admin_unverified', 'warn event must be install_admin_unverified');
});

test('resolveInstallAdmin: profile call rejects → warn payload includes authId and domain', async () => {
  const client = makeBitrixClient(new Error('some error'));
  const logger = makeLogger();

  await resolveInstallAdmin({
    bitrixClient: client,
    authId: 'my-auth-id',
    installContext: { domain: 'my-portal.bitrix24.ru', memberId: 'mem-1', userId: 3 },
    logger
  });

  const [, payload] = logger.warns[0];
  assert.equal(payload.authId, 'my-auth-id', 'warn payload must include authId');
  assert.equal(payload.domain, 'my-portal.bitrix24.ru', 'warn payload must include domain from installContext');
});

// ---------------------------------------------------------------------------
// D. profile call hangs → fail-fast via Promise.race (timeoutMs)
// ---------------------------------------------------------------------------

test('resolveInstallAdmin: profile call hangs → resolves false within timeoutMs without hanging', async () => {
  const TIMEOUT_MS = 20;
  // Never resolves — simulates a client that is stuck in retry backoff
  let hangResolve;
  const hangPromise = new Promise((resolve) => { hangResolve = resolve; });
  const client = {
    calls: [],
    callMethodWithAuth: () => { client.calls.push('profile'); return hangPromise; }
  };
  const logger = makeLogger();

  const start = Date.now();
  const result = await resolveInstallAdmin({
    bitrixClient: client,
    authId: 'token-slow',
    installContext: INSTALL_CTX,
    timeoutMs: TIMEOUT_MS,
    logger
  });
  const elapsed = Date.now() - start;

  assert.equal(result, false, 'must resolve false on timeout');
  // Should resolve within ~3x of timeoutMs, not within the 90s retry window
  assert.ok(elapsed < TIMEOUT_MS * 10, `resolved in ${elapsed}ms — too slow, timeout not working`);

  // Cleanup: resolve the hung promise so the test can finish cleanly
  hangResolve(null);
});

test('resolveInstallAdmin: profile call hangs → warn is emitted on timeout', async () => {
  const TIMEOUT_MS = 20;
  const client = {
    calls: [],
    callMethodWithAuth: () => new Promise(() => {}) // never resolves
  };
  const logger = makeLogger();

  await resolveInstallAdmin({
    bitrixClient: client,
    authId: 'token-hang',
    installContext: INSTALL_CTX,
    timeoutMs: TIMEOUT_MS,
    logger
  });

  assert.equal(logger.warns.length, 1, 'warn must be emitted on timeout');
  const [warnEvent] = logger.warns[0];
  assert.equal(warnEvent, 'install_admin_unverified');
});
