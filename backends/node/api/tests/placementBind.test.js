import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAppPlacements } from '../src/bitrix/placementBinder.js';

test('ensureAppPlacements binds both REST_APP_URI and IMMOBILE_CONTEXT_MENU when none exist', async () => {
  const bound = [];
  const bitrixClient = {
    async callMethodWithAuth(method, payload) {
      if (method === 'placement.get') return [];
      if (method === 'placement.bind') { bound.push(payload.PLACEMENT); return true; }
      return null;
    }
  };
  const result = await ensureAppPlacements({ bitrixClient, authId: 'a1', context: {}, handlerUrl: 'https://app.example/' });
  assert.ok(bound.includes('REST_APP_URI'));
  assert.ok(bound.includes('IMMOBILE_CONTEXT_MENU'));
  assert.equal(result.bound, true);
  assert.equal(result.handler, 'https://app.example/');
});

test('ensureAppPlacements does not rebind an already-bound placement', async () => {
  const bound = [];
  const bitrixClient = {
    async callMethodWithAuth(method, payload) {
      if (method === 'placement.get') return [{ placement: 'REST_APP_URI' }, { placement: 'IMMOBILE_CONTEXT_MENU' }];
      if (method === 'placement.bind') { bound.push(payload.PLACEMENT); return true; }
      return null;
    }
  };
  await ensureAppPlacements({ bitrixClient, authId: 'a1', context: {}, handlerUrl: 'https://app.example/' });
  assert.equal(bound.length, 0);
});

test('ensureAppPlacements throws without authId or handlerUrl', async () => {
  const bitrixClient = { async callMethodWithAuth() { return []; } };
  await assert.rejects(() => ensureAppPlacements({ bitrixClient, authId: '', context: {}, handlerUrl: 'https://x/' }));
  await assert.rejects(() => ensureAppPlacements({ bitrixClient, authId: 'a1', context: {}, handlerUrl: '' }));
});
