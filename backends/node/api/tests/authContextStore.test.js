import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthContextStore } from '../src/auth/authContextStore.js';

test('auth context store persists and restores merged values', async () => {
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

  const initial = await store.read();
  assert.equal(initial, null);

  await store.write({
    authId: 'access-1',
    refreshToken: 'refresh-1',
    domain: 'example.bitrix24.ru'
  });

  await store.write({
    authId: 'access-2'
  });

  const restored = await store.read();
  assert.equal(restored?.authId, 'access-2');
  assert.equal(restored?.refreshToken, 'refresh-1');
  assert.equal(restored?.domain, 'example.bitrix24.ru');
});
