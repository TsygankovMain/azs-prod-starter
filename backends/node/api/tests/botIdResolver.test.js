import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotIdResolver } from '../src/notifications/botIdResolver.js';

const createRegistry = (botId = 948) => {
  const calls = [];
  return {
    calls,
    async ensureBot({ authId, context }) {
      calls.push({ authId, context });
      return { botId };
    }
  };
};

const silentLogger = { warn() {} };

test('контекст с authId — реестр спрашивается под ним, без обращения к администратору', async () => {
  const registry = createRegistry();
  let adminAsked = 0;
  const resolve = createBotIdResolver({
    botRegistryService: registry,
    getAdminContext: async () => { adminAsked += 1; return { authId: 'admin-token' }; },
    getKnownBotId: () => 0
  });

  assert.equal(await resolve({ authId: 'user-token' }), 948);
  assert.equal(registry.calls[0].authId, 'user-token');
  assert.equal(adminAsked, 0);
});

test('контекст вебхука без authId — берётся id, уже известный процессу', async () => {
  const registry = createRegistry();
  const resolve = createBotIdResolver({
    botRegistryService: registry,
    getAdminContext: async () => ({ authId: 'admin-token' }),
    getKnownBotId: () => 948
  });

  assert.equal(await resolve({ webhookUrl: 'https://portal/rest/1/x/' }), 948);
  assert.equal(registry.calls.length, 0);
});

test('после перезапуска: authId нет, id процессу не известен — реестр под контекстом администратора', async () => {
  const registry = createRegistry();
  const resolve = createBotIdResolver({
    botRegistryService: registry,
    getAdminContext: async () => ({ key: 'k', authId: 'admin-token', domain: 'portal' }),
    getKnownBotId: () => 0
  });

  assert.equal(await resolve({ webhookUrl: 'https://portal/rest/1/x/' }), 948);
  assert.equal(registry.calls[0].authId, 'admin-token');
  assert.equal(registry.calls[0].context.domain, 'portal');
});

test('администратор ещё не заходил — 0, реестр не трогаем', async () => {
  const registry = createRegistry();
  const resolve = createBotIdResolver({
    botRegistryService: registry,
    getAdminContext: async () => ({}),
    getKnownBotId: () => 0
  });

  assert.equal(await resolve({}), 0);
  assert.equal(registry.calls.length, 0);
});

test('хранилище контекстов недоступно — 0 вместо падения рассылки', async () => {
  const registry = createRegistry();
  const resolve = createBotIdResolver({
    botRegistryService: registry,
    getAdminContext: async () => { throw new Error('db down'); },
    getKnownBotId: () => 0,
    logger: silentLogger
  });

  assert.equal(await resolve({}), 0);
});
