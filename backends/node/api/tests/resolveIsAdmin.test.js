import test from 'node:test';
import assert from 'node:assert/strict';

// Import the function under test.
// This import will fail until src/auth/resolveIsAdmin.js is created — that is
// intentional: the test must fail (RED) before we write any implementation.
const { resolveIsAdmin } = await import('../src/auth/resolveIsAdmin.js');

// ---------------------------------------------------------------------------
// Target invariant (BUG-A1 fix):
//
//   1. profile.ADMIN present (non-null, non-empty)  → authoritative; can both
//      promote AND demote (Bitrix is source of truth).
//   2. profile.ADMIN absent/null/''                 → NEVER demote below
//      previousIsAdmin.
//        a. previousIsAdmin=true  + requestAdminRaw='N'  → stays true  (THE FIX)
//        b. previousIsAdmin=false + requestAdminRaw='Y'  → elevates to true
//        c. previousIsAdmin=false + requestAdminRaw=undefined → stays false
// ---------------------------------------------------------------------------

test('resolveIsAdmin: profileAdminRaw=true → isAdmin=true (Bitrix authoritative promotion)', () => {
  const result = resolveIsAdmin({
    profileAdminRaw: 'Y',
    requestAdminRaw: 'N',
    previousIsAdmin: false
  });
  assert.equal(result, true);
});

test('resolveIsAdmin: profileAdminRaw=false → isAdmin=false (Bitrix authoritative demotion is legitimate)', () => {
  const result = resolveIsAdmin({
    profileAdminRaw: 'N',
    requestAdminRaw: 'Y',
    previousIsAdmin: true
  });
  assert.equal(result, false);
});

test('resolveIsAdmin: profileAdminRaw absent, previousIsAdmin=true, requestAdminRaw=N → stays true (BUG-A1 fix: stale body must not demote)', () => {
  // This is THE critical case. Old code: parseBoolean('N') → false (demotion).
  // New code: previousIsAdmin || parseBoolean(requestAdminRaw) → true (no demotion).
  const result = resolveIsAdmin({
    profileAdminRaw: undefined,
    requestAdminRaw: 'N',
    previousIsAdmin: true
  });
  assert.equal(result, true, 'stale body is_admin=N must not demote a previously-admin user');
});

test('resolveIsAdmin: profileAdminRaw absent, previousIsAdmin=false, requestAdminRaw=Y → elevates to true', () => {
  const result = resolveIsAdmin({
    profileAdminRaw: undefined,
    requestAdminRaw: 'Y',
    previousIsAdmin: false
  });
  assert.equal(result, true);
});

test('resolveIsAdmin: profileAdminRaw absent, previousIsAdmin=false, requestAdminRaw=undefined → stays false', () => {
  const result = resolveIsAdmin({
    profileAdminRaw: undefined,
    requestAdminRaw: undefined,
    previousIsAdmin: false
  });
  assert.equal(result, false);
});

test('resolveIsAdmin: profileAdminRaw empty string, previousIsAdmin=true, requestAdminRaw=N → stays true (empty string treated as absent)', () => {
  const result = resolveIsAdmin({
    profileAdminRaw: '',
    requestAdminRaw: 'N',
    previousIsAdmin: true
  });
  assert.equal(result, true, 'empty-string profileAdminRaw must be treated as absent — must not demote');
});

test('resolveIsAdmin: profileAdminRaw null, previousIsAdmin=true, requestAdminRaw=N → stays true', () => {
  const result = resolveIsAdmin({
    profileAdminRaw: null,
    requestAdminRaw: 'N',
    previousIsAdmin: true
  });
  assert.equal(result, true);
});

test('resolveIsAdmin: profileAdminRaw=1 (truthy string) → isAdmin=true', () => {
  const result = resolveIsAdmin({
    profileAdminRaw: '1',
    requestAdminRaw: undefined,
    previousIsAdmin: false
  });
  assert.equal(result, true);
});
