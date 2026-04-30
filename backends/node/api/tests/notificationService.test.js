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
    reportId: 15,
    azsId: 'azs-7',
    slotHHmm: '0915',
    deadlineAt: '2026-04-29T08:45:00.000Z'
  });

  assert.equal(result.channel, 'bot');
  assert.equal(botCalls.length, 1);
  assert.equal(botCalls[0].method, 'imbot.v2.Chat.Message.send');
  assert.equal(botCalls[0].payload.botId, 77);
  assert.equal(botCalls[0].payload.dialogId, '11');
  assert.match(botCalls[0].payload.fields.message, /Открыть отчёт:/);
  assert.match(botCalls[0].payload.fields.message, /marketplace\/view\/local\.69f0c4a7dc8632\.03848830/);
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
    reportId: 16,
    azsId: 'azs-9',
    slotHHmm: '1015',
    deadlineAt: '2026-04-29T09:45:00.000Z'
  });

  assert.equal(result.channel, 'notify');
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].userId, 11);
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
