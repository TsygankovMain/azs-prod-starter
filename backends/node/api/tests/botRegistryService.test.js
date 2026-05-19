import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRegistryService } from '../src/notifications/botRegistryService.js';

test('registerBot uses imbot.v2.Bot.register and returns bot id', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        return {
          bot: {
            id: 901
          }
        };
      }
    },
    botCode: 'azs_order_bot',
    botName: 'Порядок на АЗС'
  });

  const result = await service.registerBot({ authId: 'token-1' });
  assert.equal(result.botId, 901);
  assert.equal(calls[0].method, 'imbot.v2.Bot.register');
  assert.equal(calls[0].authId, 'token-1');
});

test('listBots returns normalized bot list', async () => {
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth() {
        return {
          bots: [
            { id: 10, code: 'one', type: 'bot' },
            { id: 11, code: 'two', type: 'bot' }
          ]
        };
      }
    }
  });

  const bots = await service.listBots({ authId: 'token-2' });
  assert.deepEqual(
    bots.map((item) => ({ id: item.id, code: item.code })),
    [{ id: 10, code: 'one' }, { id: 11, code: 'two' }]
  );
});

test('ensureBot reuses existing bot with configured code', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method) {
        calls.push(method);
        return {
          bots: [
            { id: 44, code: 'other_bot', type: 'bot' },
            { id: 46, code: 'azs_order_bot', type: 'bot' }
          ]
        };
      }
    },
    logger: { info() {}, warn() {} },
    botCode: 'azs_order_bot'
  });

  const result = await service.ensureBot({ authId: 'token-3' });
  assert.equal(result.botId, 46);
  assert.equal(result.reused, true);
  assert.equal(result.registered, false);
  assert.deepEqual(calls, ['imbot.v2.Bot.list']);
});

test('ensureBot registers bot when code is missing', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method) {
        calls.push(method);
        if (method === 'imbot.v2.Bot.register') {
          return { bot: { id: 901 } };
        }
        return { bots: [] };
      }
    },
    logger: { info() {}, warn() {} },
    botCode: 'azs_order_bot'
  });

  const result = await service.ensureBot({ authId: 'token-4' });
  assert.equal(result.botId, 901);
  assert.equal(result.reused, false);
  assert.equal(result.registered, true);
  assert.deepEqual(calls, [
    'imbot.v2.Bot.list',
    'imbot.v2.Bot.register',
    'imbot.v2.Bot.list'
  ]);
});
