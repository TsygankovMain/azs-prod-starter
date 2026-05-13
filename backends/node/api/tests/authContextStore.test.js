import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthContextStore, buildAuthContextKey } from '../src/auth/authContextStore.js';

test('buildAuthContextKey normalizes identity tuple', () => {
  const key = buildAuthContextKey({
    memberId: 'abc123',
    domain: 'NFR-MAINSOFT.BITRIX24.RU',
    userId: '11'
  });
  assert.equal(key, 'abc123:nfr-mainsoft.bitrix24.ru:11');
});

test('auth context store persists per-user contexts and restores last admin', async () => {
  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'auth-context-store-'));
  } catch (error) {
    if (error?.code === 'EPERM') {
      return;
    }
    throw error;
  }
  const filePath = join(dir, 'auth-context.json');
  const store = new AuthContextStore(filePath);

  const initial = await store.getContext({
    memberId: 'm1',
    domain: 'nfr-mainsoft.bitrix24.ru',
    userId: 11
  });
  assert.equal(initial, null);

  await store.upsertContext({
    memberId: 'm1',
    userId: 11,
    domain: 'nfr-mainsoft.bitrix24.ru',
    authId: 'access-1',
    refreshToken: 'refresh-1',
    isAdmin: true
  });

  await store.upsertContext({
    memberId: 'm1',
    userId: 11,
    domain: 'nfr-mainsoft.bitrix24.ru',
    authId: 'access-2'
  });

  const restored = await store.getContext({
    memberId: 'm1',
    domain: 'nfr-mainsoft.bitrix24.ru',
    userId: 11
  });
  assert.equal(restored?.authId, 'access-2');
  assert.equal(restored?.refreshToken, 'refresh-1');
  assert.equal(restored?.domain, 'nfr-mainsoft.bitrix24.ru');

  const lastAdmin = await store.getLastAdminContext();
  assert.equal(lastAdmin?.context?.userId, 11);
  assert.equal(lastAdmin?.context?.isAdmin, true);
});

test('getLastAdminContext returns null when no admin context exists', async () => {
  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'auth-context-store-'));
  } catch (error) {
    if (error?.code === 'EPERM') return;
    throw error;
  }
  const filePath = join(dir, 'auth-context-no-admin.json');
  const store = new AuthContextStore(filePath);

  await store.upsertContext({
    memberId: 'm1',
    domain: 'nfr-mainsoft.bitrix24.ru',
    userId: 1,
    authId: 'a1',
    refreshToken: 'r1',
    isAdmin: false
  });

  const result = await store.getLastAdminContext();
  assert.equal(result, null, 'must not fall back to non-admin context');
});

test('listContexts returns every stored context', async () => {
  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'auth-context-store-'));
  } catch (error) {
    if (error?.code === 'EPERM') return;
    throw error;
  }
  const filePath = join(dir, 'auth-context-list.json');
  const store = new AuthContextStore(filePath);

  await store.upsertContext({
    memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1, authId: 't1', refreshToken: 'r1'
  });
  await store.upsertContext({
    memberId: 'm1', domain: 'a.bitrix24.ru', userId: 2, authId: 't2', refreshToken: 'r2'
  });

  const list = await store.listContexts();
  assert.equal(list.length, 2);
  assert.ok(list.every((entry) => typeof entry.key === 'string' && entry.context));
});

test('refreshTokenIssuedAt is preserved across upserts', async () => {
  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'auth-context-store-'));
  } catch (error) {
    if (error?.code === 'EPERM') return;
    throw error;
  }
  const filePath = join(dir, 'auth-context-issued.json');
  const store = new AuthContextStore(filePath);

  const issuedAt = '2026-04-01T10:00:00.000Z';
  await store.upsertContext({
    memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1,
    authId: 't1', refreshToken: 'r1',
    isAdmin: true,
    refreshTokenIssuedAt: issuedAt
  });

  const ctx = await store.getContext({ memberId: 'm1', domain: 'a.bitrix24.ru', userId: 1 });
  assert.equal(ctx.refreshTokenIssuedAt, issuedAt);
  assert.equal(ctx.isAdmin, true);
});

test('auth context store handles concurrent upserts without loss', async () => {
  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'auth-context-store-'));
  } catch (error) {
    if (error?.code === 'EPERM') {
      return;
    }
    throw error;
  }
  const filePath = join(dir, 'auth-context-concurrent.json');
  const store = new AuthContextStore(filePath);

  await Promise.all([
    store.upsertContext({
      memberId: 'm1',
      domain: 'nfr-mainsoft.bitrix24.ru',
      userId: 1,
      authId: 'token-1',
      refreshToken: 'refresh-1'
    }),
    store.upsertContext({
      memberId: 'm1',
      domain: 'nfr-mainsoft.bitrix24.ru',
      userId: 2,
      authId: 'token-2',
      refreshToken: 'refresh-2'
    }),
    store.upsertContext({
      memberId: 'm1',
      domain: 'nfr-mainsoft.bitrix24.ru',
      userId: 3,
      authId: 'token-3',
      refreshToken: 'refresh-3'
    })
  ]);

  const c1 = await store.getContext({ memberId: 'm1', domain: 'nfr-mainsoft.bitrix24.ru', userId: 1 });
  const c2 = await store.getContext({ memberId: 'm1', domain: 'nfr-mainsoft.bitrix24.ru', userId: 2 });
  const c3 = await store.getContext({ memberId: 'm1', domain: 'nfr-mainsoft.bitrix24.ru', userId: 3 });
  assert.equal(c1?.authId, 'token-1');
  assert.equal(c2?.authId, 'token-2');
  assert.equal(c3?.authId, 'token-3');
});
