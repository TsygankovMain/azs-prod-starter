import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService } from '../src/notifications/notificationService.js';
import { buildReportLinks } from '../src/notifications/reportLinks.js';

test('buildReportLinks returns REST_APP_URI and public fallback links', () => {
  const links = buildReportLinks({
    appCode: 'local.69f0c4a7dc8632.03848830',
    reportId: 12,
    publicBaseUrl: 'https://simply-staid-mollusk.cloudpub.ru/'
  });

  assert.equal(links.appPath, '/admin/12');
  assert.match(links.restAppUriLink, /^\/marketplace\/view\/local\.69f0c4a7dc8632\.03848830\/\?/);
  assert.match(links.restAppUriLink, /params%5BreportId%5D=12/);
  assert.equal(links.publicReportUrl, 'https://simply-staid-mollusk.cloudpub.ru/admin/12');
});

test('notifyDispatch sends message via bot channel when mode=bot', async () => {
  const botCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        botCalls.push({ method, payload });
        return { id: 5001 };
      },
      async notifyUser() {
        throw new Error('notify fallback should not be called');
      }
    },
    mode: 'bot',
    botId: 77,
    appCode: 'local.69f0c4a7dc8632.03848830',
    publicBaseUrl: 'https://simply-staid-mollusk.cloudpub.ru'
  });

  const result = await service.notifyDispatch({
    userId: 11,
    azsId: 'azs-7',
    deadlineAt: '2026-04-29T08:45:00.000Z',
    timezone: 'Europe/Moscow'
  });

  assert.equal(result.channel, 'bot');
  assert.equal(botCalls.length, 1);
  assert.equal(botCalls[0].method, 'imbot.v2.Chat.Message.send');
  assert.equal(botCalls[0].payload.botId, 77);
  assert.equal(botCalls[0].payload.dialogId, '11');
  assert.equal(botCalls[0].payload.fields.keyboard, undefined);
  assert.match(botCalls[0].payload.fields.message, /Время сделать фото-отчёт по АЗС azs-7/);
  assert.match(botCalls[0].payload.fields.message, /Сдать до 11:45/);
  assert.doesNotMatch(botCalls[0].payload.fields.message, /Слот:/);
  assert.doesNotMatch(botCalls[0].payload.fields.message, /Дедлайн:/);
});

test('notifyDispatch falls back to notify channel when bot send fails', async () => {
  const notifyCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async callMethod() {
        throw new Error('imbot failed');
      },
      async notifyUser(payload) {
        notifyCalls.push(payload);
        return { ok: true };
      }
    },
    mode: 'bot',
    botId: 77,
    appCode: 'local.69f0c4a7dc8632.03848830',
    publicBaseUrl: 'https://simply-staid-mollusk.cloudpub.ru'
  });

  const result = await service.notifyDispatch({
    userId: 11,
    azsId: 'azs-9',
    deadlineAt: '2026-04-29T09:45:00.000Z',
    timezone: 'Europe/Moscow'
  });

  assert.equal(result.channel, 'notify');
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].userId, 11);
});

test('notifyDispatch resolves bot id dynamically when env bot id is empty', async () => {
  const botCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        botCalls.push({ method, payload });
        return { id: 5002 };
      },
      async notifyUser() {
        throw new Error('notify fallback should not be called');
      }
    },
    mode: 'bot',
    botId: 0,
    appCode: 'local.69f0c4a7dc8632.03848830',
    publicBaseUrl: 'https://simply-staid-mollusk.cloudpub.ru',
    async resolveBotId(context) {
      assert.equal(context.domain, 'example.bitrix24.ru');
      return 88;
    }
  });

  const result = await service.notifyDispatch({
    userId: 11,
    azsId: 'azs-10',
    deadlineAt: '2026-04-29T10:45:00.000Z',
    timezone: 'Europe/Moscow',
    context: {
      domain: 'example.bitrix24.ru',
      authId: 'runtime-token'
    }
  });

  assert.equal(result.channel, 'bot');
  assert.equal(botCalls.length, 1);
  assert.equal(botCalls[0].payload.botId, 88);
});

test('notifyDispatch in bot-mode forwards keyboard to imbot.v2.Chat.Message.send', async () => {
  const botCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        botCalls.push({ method, payload });
        return { id: 6001 };
      },
      async notifyUser() {
        throw new Error('notify fallback should not be called');
      }
    },
    mode: 'bot',
    botId: 77
  });

  const keyboard = [[{ TEXT: 'Открыть приложение', LINK: '/marketplace/view/local.app/?params%5BreportId%5D=99' }]];

  const result = await service.notifyDispatch({
    userId: 22,
    azsId: 'azs-kb-1',
    deadlineAt: '2026-06-01T09:00:00.000Z',
    timezone: 'Europe/Moscow',
    keyboard
  });

  assert.equal(result.channel, 'bot');
  assert.equal(botCalls.length, 1);
  assert.deepEqual(botCalls[0].payload.fields.keyboard, keyboard, 'keyboard must be forwarded as-is to imbot.v2.Chat.Message.send');
});

test('notify in bot-mode with keyboard forwards keyboard to API call', async () => {
  const botCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        botCalls.push({ method, payload });
        return { id: 6002 };
      }
    },
    mode: 'bot',
    botId: 88
  });

  const keyboard = [[{ TEXT: 'Указать причину', LINK: '/marketplace/view/local.app/?params%5BreportId%5D=10' }]];

  const result = await service.notify({
    userId: 33,
    message: 'Отчёт просрочен. Пожалуйста, укажите причину.',
    keyboard
  });

  assert.equal(result.channel, 'bot');
  assert.equal(botCalls.length, 1);
  assert.deepEqual(botCalls[0].payload.fields.keyboard, keyboard, 'keyboard must be passed through in bot mode');
});

test('notify in notify-mode ignores keyboard — no keyboard field in notifyUser call', async () => {
  const notifyCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async notifyUser(payload) {
        notifyCalls.push(payload);
        return { ok: true };
      }
    },
    mode: 'notify'
  });

  const keyboard = [[{ TEXT: 'Открыть приложение', LINK: '/marketplace/view/local.app/?params%5BreportId%5D=99' }]];

  const result = await service.notifyDispatch({
    userId: 44,
    azsId: 'azs-notify-1',
    deadlineAt: '2026-06-01T09:00:00.000Z',
    timezone: 'Europe/Moscow',
    keyboard
  });

  assert.equal(result.channel, 'notify', 'must use notify channel');
  assert.equal(notifyCalls.length, 1, 'notifyUser must be called once');
  // keyboard is not part of the notifyUser contract — no keyboard field expected
  assert.equal(notifyCalls[0].keyboard, undefined, 'keyboard must NOT be forwarded in notify mode');
});

test('bitrix client auth id can be updated at runtime', async () => {
  const calls = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body || '{}')));
    return {
      ok: true,
      async json() {
        return { result: { id: 1 } };
      }
    };
  };

  try {
    const { createBitrixRestClient } = await import('../src/dispatch/bitrixRestClient.js');
    const client = createBitrixRestClient({
      endpoint: 'https://example.bitrix24.ru/rest',
      authId: 'old-token'
    });
    client.setAuthId('new-token');
    await client.callMethod('imbot.v2.Bot.list', {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, 'new-token');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
