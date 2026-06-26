import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService, NOTIFY_FALLBACK_PREFIX } from '../src/notifications/notificationService.js';
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

test('notify uses bot by default (mode not specified)', async () => {
  const botCalls = [];
  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) { botCalls.push({ method, payload }); return { id: 1 }; },
      async notifyUser() { throw new Error('im.notify must never be called'); }
    },
    botId: 42
  });
  const result = await service.notify({ userId: 5, message: 'привет' });
  assert.equal(result.channel, 'bot');
  assert.equal(botCalls[0].method, 'imbot.v2.Chat.Message.send');
});

test('on bot failure notify alerts admins via bot, never the bell', async () => {
  const calls = [];
  let notifyUserCalled = false;
  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        calls.push({ method, payload });
        if (payload.dialogId === '5') throw new Error('BOT_TOKEN_NOT_SPECIFIED');
        return { id: 2 };
      },
      async notifyUser() { notifyUserCalled = true; return { ok: true }; }
    },
    botId: 42,
    adminUserIds: [900, 901]
  });
  const result = await service.notify({ userId: 5, message: 'пора сдать отчёт', azsId: 'azs-1' });
  assert.equal(notifyUserCalled, false, 'колокольчик не должен вызываться');
  assert.equal(result.channel, 'admin_alert');
  assert.equal(result.delivered, false);
  const adminMsgs = calls.filter((c) => c.payload.dialogId === '900' || c.payload.dialogId === '901');
  assert.equal(adminMsgs.length, 2);
  assert.match(adminMsgs[0].payload.fields.message, /Не удалось доставить/);
  assert.match(adminMsgs[0].payload.fields.message, /azs-1/);
});

test('on total bot failure (no admins reachable) returns undelivered without throwing', async () => {
  const service = createNotificationService({
    bitrixClient: {
      async callMethod() { throw new Error('BOT_TOKEN_NOT_SPECIFIED'); },
      async notifyUser() { throw new Error('im.notify must never be called'); }
    },
    botId: 42,
    adminUserIds: [900]
  });
  const result = await service.notify({ userId: 5, message: 'x' });
  assert.equal(result.delivered, false);
  assert.equal(result.channel, 'undelivered');
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

// W1-1: flat {BOT_ID, BUTTONS} keyboard format
test('notifyDispatch in bot-mode forwards flat keyboard {BOT_ID, BUTTONS} to imbot.v2.Chat.Message.send', async () => {
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

  // W1-1: flat {BOT_ID, BUTTONS} format — no nested arrays
  const keyboard = {
    BOT_ID: 77,
    BUTTONS: [
      { TEXT: 'Открыть приложение', LINK: '/marketplace/view/local.app/?params%5BreportId%5D=99' },
      { TYPE: 'NEWLINE' },
      { TEXT: 'Не успеваю — указать причину', LINK: '/marketplace/view/local.app/?params%5BreportId%5D=99&reason=1' }
    ]
  };

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
  // Verify no nested arrays in BUTTONS
  for (const btn of keyboard.BUTTONS) {
    assert.ok(!Array.isArray(btn), 'keyboard.BUTTONS elements must NOT be nested arrays (flat format)');
  }
});

test('notify in bot-mode with flat keyboard forwards keyboard to API call', async () => {
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

  // W1-1: flat {BOT_ID, BUTTONS} format
  const keyboard = {
    BOT_ID: 88,
    BUTTONS: [{ TEXT: 'Указать причину', LINK: '/marketplace/view/local.app/?params%5BreportId%5D=10' }]
  };

  const result = await service.notify({
    userId: 33,
    message: 'Отчёт просрочен. Пожалуйста, укажите причину.',
    keyboard
  });

  assert.equal(result.channel, 'bot');
  assert.equal(botCalls.length, 1);
  assert.deepEqual(botCalls[0].payload.fields.keyboard, keyboard, 'keyboard must be passed through in bot mode');
});

// NOTIF-BOT-ONLY: даже при mode='notify' доставка идёт ТОЛЬКО ботом (колокольчик вырезан).
test('notify-only: даже mode=notify доставляет ботом с клавиатурой, im.notify не зовётся', async () => {
  const botCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        botCalls.push({ method, payload });
        return { id: 7001 };
      },
      async notifyUser() {
        throw new Error('im.notify must never be called');
      }
    },
    mode: 'notify',
    botId: 55
  });

  // W1-1: flat {BOT_ID, BUTTONS} format — forwarded to bot
  const keyboard = {
    BOT_ID: 55,
    BUTTONS: [{ TEXT: 'Открыть приложение', LINK: '/marketplace/view/local.app/?params%5BreportId%5D=99' }]
  };

  const result = await service.notifyDispatch({
    userId: 44,
    azsId: 'azs-notify-1',
    deadlineAt: '2026-06-01T09:00:00.000Z',
    timezone: 'Europe/Moscow',
    keyboard
  });

  assert.equal(result.channel, 'bot', 'must use bot channel only');
  assert.equal(botCalls.length, 1, 'bot send must be called once');
  assert.equal(botCalls[0].method, 'imbot.v2.Chat.Message.send');
  assert.deepEqual(botCalls[0].payload.fields.keyboard, keyboard, 'keyboard must be forwarded to bot');
});

// W1-2: NOTIFY_FALLBACK_PREFIX exported and correct
test('W1-2: NOTIFY_FALLBACK_PREFIX is exported with correct format', () => {
  assert.ok(typeof NOTIFY_FALLBACK_PREFIX === 'string', 'NOTIFY_FALLBACK_PREFIX must be a string');
  assert.ok(NOTIFY_FALLBACK_PREFIX.startsWith('delivered via notify fallback'), 'must start with expected prefix');
});

// NOTIF-BOT-ONLY: bot fails, no admins → return {delivered:false, channel:'undelivered', botError}; warn logged
test('bot failure без админов → {delivered:false, channel:undelivered, botError}; bot_channel_degraded warn logged', async () => {
  const warnCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async callMethod() {
        throw new Error('PARAM_KEYBOARD_ERROR');
      },
      async notifyUser() {
        throw new Error('im.notify must never be called');
      }
    },
    mode: 'bot',
    botId: 77,
    logger: {
      warn(event, meta) { warnCalls.push({ event, meta }); },
      info() {},
      error() {}
    }
  });

  const result = await service.notify({
    userId: 55,
    message: 'Тест деградации'
  });

  assert.equal(result.delivered, false, 'delivered must be false (bot-only, no fallback)');
  assert.equal(result.channel, 'undelivered', 'channel must be undelivered');
  assert.ok(typeof result.botError === 'string' && result.botError.length > 0, 'botError must be non-empty string');
  assert.ok(result.botError.includes('PARAM_KEYBOARD_ERROR'), 'botError must contain original error reason');

  const degradedWarn = warnCalls.find((w) => w.event === 'bot_channel_degraded');
  assert.ok(degradedWarn, 'bot_channel_degraded warn must be logged');
  assert.ok(
    typeof degradedWarn.meta.reason === 'string' && degradedWarn.meta.reason.length > 0,
    'warn reason must be informative'
  );
  assert.equal(degradedWarn.meta.dialogId, '55', 'warn dialogId must match userId');
});

// Self-heal: BOT_NOT_FOUND → ensureBot called once → retry succeeds
test('self-heal: BOT_NOT_FOUND → ensureBot called 1x → retry succeeds, no notify fallback', async () => {
  const ensureBotCalls = [];
  const sendAttempts = [];
  let callCount = 0;

  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        sendAttempts.push(payload);
        callCount += 1;
        if (callCount === 1) {
          throw new Error('BOT_NOT_FOUND');
        }
        return { id: 9001 };
      },
      async notifyUser() {
        throw new Error('should not fallback on self-heal success');
      }
    },
    mode: 'bot',
    botId: 77,
    ensureBot: async (ctx) => {
      ensureBotCalls.push(ctx);
      return { botId: 99 };
    },
    logger: { warn() {}, info() {}, error() {} }
  });

  const result = await service.notify({
    userId: 11,
    message: 'Self-heal test'
  });

  assert.equal(result.channel, 'bot', 'must succeed via bot after self-heal');
  assert.equal(ensureBotCalls.length, 1, 'ensureBot must be called exactly once');
  assert.equal(sendAttempts.length, 2, 'must have 2 send attempts (original + retry)');
  assert.equal(sendAttempts[1].botId, 99, 'retry must use healed botId');
});

// Self-heal: PARAM_KEYBOARD_ERROR → ensureBot NOT called, no bell, undelivered
test('self-heal: PARAM_KEYBOARD_ERROR → ensureBot NOT called → undelivered, im.notify не зовётся', async () => {
  const ensureBotCalls = [];

  const service = createNotificationService({
    bitrixClient: {
      async callMethod() {
        throw new Error('PARAM_KEYBOARD_ERROR');
      },
      async notifyUser() {
        throw new Error('im.notify must never be called');
      }
    },
    mode: 'bot',
    botId: 77,
    ensureBot: async (ctx) => {
      ensureBotCalls.push(ctx);
      return { botId: 99 };
    },
    logger: { warn() {}, info() {}, error() {} }
  });

  const result = await service.notify({
    userId: 22,
    message: 'PARAM error test'
  });

  assert.equal(ensureBotCalls.length, 0, 'ensureBot must NOT be called for PARAM_* errors');
  assert.equal(result.channel, 'undelivered', 'must be undelivered (no notify fallback, no admins)');
  assert.equal(result.delivered, false);
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

// ─── NOTIF-1: диагностика доставки (transport/канал/получатель) ──────────────
// Цель: при следующей рассылке логи однозначно показывают для КАЖДОЙ доставки —
// кому (userId/azsId), каким каналом (bot/notify), под какой авторизацией
// (oauth/webhook) и с какой ошибкой. Это добывает прод-данные для 485/486.

test('NOTIF-1: успешная доставка ботом логирует notification_delivery channel=bot transport=oauth', async () => {
  const infoCalls = [];
  const service = createNotificationService({
    bitrixClient: {
      async callMethod() { return { id: 1 }; },
      async notifyUser() { throw new Error('фоллбэк не должен вызываться'); }
    },
    mode: 'bot',
    botId: 77,
    logger: {
      info(event, meta) { infoCalls.push({ event, meta }); },
      warn() {},
      error() {}
    }
  });

  await service.notifyDispatch({
    userId: 11,
    azsId: 'azs-485',
    deadlineAt: '2026-06-16T09:00:00.000Z',
    timezone: 'Europe/Moscow',
    context: { authId: 'live-token', domain: 'p.bitrix24.ru' }
  });

  const delivery = infoCalls.find((c) => c.event === 'notification_delivery');
  assert.ok(delivery, 'должен логироваться notification_delivery');
  assert.equal(delivery.meta.channel, 'bot');
  assert.equal(delivery.meta.transport, 'oauth');
  assert.equal(delivery.meta.userId, 11);
  assert.equal(delivery.meta.azsId, 'azs-485');
});

test('NOTIF-1: под webhook bot падает → notification_delivery channel=undelivered transport=webhook + bot_delivery_auth_problem', async () => {
  const infoCalls = [];
  const errorCalls = [];
  const service = createNotificationService({
    bitrixClient: {
      async callMethod() {
        throw new Error('BOT_TOKEN_NOT_SPECIFIED (botToken required for webhook auth)');
      },
      async notifyUser() { throw new Error('im.notify must never be called'); }
    },
    mode: 'bot',
    botId: 77,
    logger: {
      info(event, meta) { infoCalls.push({ event, meta }); },
      warn() {},
      error(event, meta) { errorCalls.push({ event, meta }); }
    }
  });

  const result = await service.notify({
    userId: 486,
    message: 'тест доставки',
    azsId: 'azs-486',
    context: { isWebhook: true, endpoint: 'https://p.bitrix24.ru/rest/1/abc' }
  });

  assert.equal(result.channel, 'undelivered');

  const delivery = infoCalls.find((c) => c.event === 'notification_delivery' && c.meta.channel === 'undelivered');
  assert.ok(delivery, 'должен логироваться notification_delivery для undelivered-канала');
  assert.equal(delivery.meta.transport, 'webhook');
  assert.equal(delivery.meta.azsId, 'azs-486');
  assert.ok(
    typeof delivery.meta.botError === 'string' && delivery.meta.botError.includes('BOT_TOKEN_NOT_SPECIFIED'),
    'в логе доставки должна быть причина падения бот-канала'
  );

  const authProblem = errorCalls.find((c) => c.event === 'bot_delivery_auth_problem');
  assert.ok(authProblem, 'на auth-ошибке должен быть человеческий error-лог bot_delivery_auth_problem');
  assert.equal(authProblem.meta.transport, 'webhook');
  assert.equal(authProblem.meta.userId, 486);
  assert.ok(authProblem.meta.botError.includes('BOT_TOKEN_NOT_SPECIFIED'));
  assert.ok(
    typeof authProblem.meta.hint === 'string' && authProblem.meta.hint.length > 0,
    'auth-лог должен содержать человеческую подсказку'
  );
});

// NOTIF-BOT-ONLY: при сбое бота алерт уходит админам тем же ботом, im.notify не зовётся
test('NOTIF-BOT-ONLY: при сбое бота алерт админам идёт ботом, без колокольчика', async () => {
  const calls = [];
  const service = createNotificationService({
    bitrixClient: {
      async callMethod(method, payload) {
        calls.push({ method, payload });
        if (payload.dialogId === '11') { throw new Error('imbot недоступен'); }
        return { id: 1 };
      },
      async notifyUser() { throw new Error('im.notify must never be called'); }
    },
    mode: 'bot',
    botId: 77,
    adminUserIds: [900],
    logger: { info() {}, warn() {}, error() {} }
  });

  const result = await service.notify({
    userId: 11,
    message: 'Отчёт просрочен.',
    azsId: 'azs-42'
  });

  assert.equal(result.channel, 'admin_alert');
  assert.equal(result.delivered, false);
  const adminMsg = calls.find((c) => c.payload.dialogId === '900');
  assert.ok(adminMsg, 'админ должен получить алерт ботом');
  assert.match(adminMsg.payload.fields.message, /Не удалось доставить/);
  assert.match(adminMsg.payload.fields.message, /azs-42/);
});
