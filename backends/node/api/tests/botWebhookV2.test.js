/**
 * BUG-019 v2 fix: tests for the corrected Bitrix24 bot webhook integration.
 *
 * (a) Button is ACTION:SEND with ACTION_VALUE '/reason <id>', NOT COMMAND/LINK.
 * (b) Registration uses eventMode:'webhook' + webhookUrl with ?s, NO event_message_add.
 * (c) /api/bot/event parses v2 urlencoded ONIMBOTV2MESSAGEADD '/reason 42' →
 *     starts awaiting + replies.
 * (d) Follow-up plain message records reason.
 * (e) Wrong/missing ?s still fail-closed.
 *
 * TDD: all tests written FIRST — must fail before implementation is changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRegistryService } from '../src/notifications/botRegistryService.js';
import { createDispatchService } from '../src/dispatch/dispatchService.js';
import { createTimeoutWatcher } from '../src/dispatch/timeoutWatcher.js';
import { createBotCommandHandler } from '../src/notifications/botCommandHandler.js';
import { createReasonCaptureStore } from '../src/notifications/reasonCaptureStore.js';

// ─── (b) Registration: eventMode:'webhook', webhookUrl, no event_message_add ──

test('(b) botRegistryService: registerBot uses eventMode:webhook, not fetch', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        return { bot: { id: 901 } };
      }
    },
    botCode: 'azs_order_bot',
    handlerBaseUrl: 'https://example.com',
    jobSecret: 'mysecret'
  });

  await service.registerBot({ authId: 'token-1' });

  const registerCall = calls.find((c) => c.method === 'imbot.v2.Bot.register');
  assert.ok(registerCall, 'imbot.v2.Bot.register must be called');

  const fields = registerCall.params.fields;
  assert.equal(fields.eventMode, 'webhook', 'eventMode must be "webhook"');
});

test('(b) botRegistryService: registerBot uses webhookUrl field, not event_message_add', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        return { bot: { id: 901 } };
      }
    },
    botCode: 'azs_order_bot',
    handlerBaseUrl: 'https://example.com',
    jobSecret: 'mysecret'
  });

  await service.registerBot({ authId: 'token-1' });

  const registerCall = calls.find((c) => c.method === 'imbot.v2.Bot.register');
  const fields = registerCall.params.fields;

  // webhookUrl must contain /api/bot/event?s=mysecret
  assert.ok(
    typeof fields.webhookUrl === 'string' && fields.webhookUrl.includes('/api/bot/event'),
    `fields.webhookUrl must include /api/bot/event, got: ${fields.webhookUrl}`
  );
  assert.ok(
    fields.webhookUrl.includes('?s=mysecret'),
    `fields.webhookUrl must include ?s=mysecret, got: ${fields.webhookUrl}`
  );

  // event_message_add must NOT be present
  assert.equal(
    fields.event_message_add,
    undefined,
    'fields.event_message_add must be absent in v2 webhook mode'
  );
});

test('(b) botRegistryService: webhookUrl exact format is <base>/api/bot/event?s=<secret>', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        return { bot: { id: 901 } };
      }
    },
    botCode: 'azs_order_bot',
    handlerBaseUrl: 'https://app.example.com',
    jobSecret: 'abc123'
  });

  await service.registerBot({ authId: 'token-1' });

  const registerCall = calls.find((c) => c.method === 'imbot.v2.Bot.register');
  const fields = registerCall.params.fields;

  assert.equal(
    fields.webhookUrl,
    'https://app.example.com/api/bot/event?s=abc123',
    `webhookUrl must be exactly <base>/api/bot/event?s=<secret>, got: ${fields.webhookUrl}`
  );
});

// ─── (b2) EXISTING bot: webhook mode applied via Bot.update, not register ──────
// Bitrix24: imbot.v2.Bot.register is a no-op for an already-registered code and
// does NOT switch eventMode/webhookUrl. An existing bot must be updated.

test('(b2) ensureBot on an EXISTING bot applies webhook mode via Bot.update (not register)', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        if (method === 'imbot.v2.Bot.list') {
          return { bots: [{ id: 555, code: 'azs_order_bot', type: 'bot' }] };
        }
        return { bot: { id: 555 } };
      }
    },
    botCode: 'azs_order_bot',
    handlerBaseUrl: 'https://app.example.com',
    jobSecret: 'sekret'
  });

  const reuse = await service.ensureBot({ authId: 'tok' });
  assert.equal(reuse.botId, 555);
  const updateCall = calls.find((c) => c.method === 'imbot.v2.Bot.update');
  assert.ok(updateCall, 'existing bot must be updated via imbot.v2.Bot.update');
  assert.equal(updateCall.params.fields.eventMode, 'webhook', 'update must set eventMode=webhook');
  assert.ok(
    String(updateCall.params.fields.webhookUrl).includes('/api/bot/event?s=sekret'),
    `update must set webhookUrl with secret, got: ${updateCall.params.fields.webhookUrl}`
  );
  assert.ok(
    !calls.some((c) => c.method === 'imbot.v2.Bot.register'),
    'must NOT call Bot.register for an existing bot (it would not switch mode)'
  );
});

test('(b3) ensureBot force-reregister on existing bot re-applies webhook mode via Bot.update', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        if (method === 'imbot.v2.Bot.list') {
          return { bots: [{ id: 777, code: 'azs_order_bot', type: 'bot' }] };
        }
        return { bot: { id: 777 } };
      }
    },
    botCode: 'azs_order_bot',
    handlerBaseUrl: 'https://app.example.com',
    jobSecret: 'sekret'
  });

  const res = await service.ensureBot({ authId: 'tok', force: true });
  assert.equal(res.botId, 777);
  assert.equal(res.registered, true);
  const updateCall = calls.find((c) => c.method === 'imbot.v2.Bot.update');
  assert.ok(updateCall, 'force-reregister must update the existing bot via Bot.update');
  assert.equal(updateCall.params.fields.eventMode, 'webhook');
  assert.ok(String(updateCall.params.fields.webhookUrl).includes('/api/bot/event?s=sekret'));
});

// ─── (a) Dispatch button: ACTION:SEND with ACTION_VALUE '/reason <id>' ─────────

const createDispatchFake = () => {
  let seq = 100;
  const reservations = new Map();
  return {
    async reserve({ slotKey, azsId }) {
      const key = `${slotKey}:${azsId}`;
      if (reservations.has(key)) return { reserved: false, id: null };
      seq += 1;
      reservations.set(key, seq);
      return { reserved: true, id: seq };
    },
    async markDone() {},
    async markFailed() {},
    async appendErrorText() {}
  };
};

const baseSettings = {
  report: {
    entityTypeId: 163,
    timeoutMinutes: 60,
    dispatchJitterMinutes: 0,
    fields: { azs: 'UF_AZS', trigger: 'UF_TRIGGER' },
    stages: { new: 'DT163_1:NEW' }
  }
};

test('(a) dispatchService: keyboard button is ACTION:SEND with ACTION_VALUE containing /reason <id>', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.test.v2send';

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createDispatchFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 7001 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-06-12T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({
      candidates: [{
        azsId: 'azs-v2-1',
        adminUserId: 55,
        slotDate: '2026-06-12',
        slotHHmm: '1000'
      }],
      trigger: 'auto'
    });

    assert.equal(notifiedPayloads.length, 1);
    const { keyboard } = notifiedPayloads[0];

    assert.ok(keyboard !== null && keyboard !== undefined, 'keyboard must be present');
    assert.ok(Array.isArray(keyboard.BUTTONS), 'keyboard.BUTTONS must be an array');

    const realButtons = keyboard.BUTTONS.filter((b) => b.ACTION !== 'NEWLINE' && b.TYPE !== 'NEWLINE');
    assert.ok(realButtons.length >= 1, 'must have at least one real button');

    // Find the "reason" button
    const reasonBtn = realButtons.find((b) =>
      String(b.TEXT || '').includes('причину') || String(b.TEXT || '').includes('Указать')
    );
    assert.ok(reasonBtn !== undefined, '«Указать причину» button must exist');

    // Must be ACTION:SEND, not TYPE:COMMAND
    assert.equal(reasonBtn.ACTION, 'SEND', 'button must have ACTION:SEND');
    assert.equal(reasonBtn.TYPE, undefined, 'button must NOT have TYPE field');
    assert.equal(reasonBtn.COMMAND, undefined, 'button must NOT have COMMAND field');
    assert.equal(reasonBtn.LINK, undefined, 'button must NOT have LINK field');

    // ACTION_VALUE must be '/reason <reportId>'
    assert.ok(
      typeof reasonBtn.ACTION_VALUE === 'string' && reasonBtn.ACTION_VALUE.match(/^\/reason\s+\d+$/),
      `ACTION_VALUE must be '/reason <id>', got: ${reasonBtn.ACTION_VALUE}`
    );
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('(a) dispatchService: ACTION_VALUE contains the correct reportId', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.test.v2send2';

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createDispatchFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 9999 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-06-12T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({
      candidates: [{
        azsId: 'azs-v2-2',
        adminUserId: 55,
        slotDate: '2026-06-12',
        slotHHmm: '1000'
      }],
      trigger: 'auto'
    });

    const { keyboard } = notifiedPayloads[0];
    const realButtons = keyboard.BUTTONS.filter((b) => b.ACTION !== 'NEWLINE' && b.TYPE !== 'NEWLINE');
    const reasonBtn = realButtons.find((b) =>
      String(b.TEXT || '').includes('причину') || String(b.TEXT || '').includes('Указать')
    );

    // ACTION_VALUE should be '/reason 9999' (the reportItemId returned by createReportItem)
    assert.ok(
      reasonBtn.ACTION_VALUE.includes('9999'),
      `ACTION_VALUE must include reportId 9999, got: ${reasonBtn.ACTION_VALUE}`
    );
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('(a) timeoutWatcher: overdue reason button is ACTION:SEND, not COMMAND', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.test.v2tw';

    const notifyCalls = [];
    const watcher = createTimeoutWatcher({
      reportsStore: {
        async listOverdueReports() {
          return [{ id: 88, azsId: 'azs-tw-v2', adminUserId: 5, status: 'pending', deadlineAt: new Date('2026-06-11T10:00:00.000Z') }];
        },
        async setReportStatus() {}
      },
      dispatchLogStore: null,
      bitrixClient: {
        async callMethod() { return { ok: true }; }
      },
      settingsStore: {
        async read() { return {}; }
      },
      notificationService: {
        get botId() { return 888; },
        async notify(payload) { notifyCalls.push(payload); return { channel: 'bot', delivered: true }; },
        async notifyReportExpired() {}
      },
      reasonStore: {
        async getByReport() { return null; }
      },
      nowFn: () => new Date('2026-06-12T10:00:00.000Z')
    });

    await watcher.runOnce({});

    const callWithKeyboard = notifyCalls.find((c) => c.keyboard != null);
    assert.ok(callWithKeyboard !== undefined, 'at least one notify call must include a keyboard');

    const { keyboard } = callWithKeyboard;
    const realButtons = keyboard.BUTTONS.filter((b) => b.ACTION !== 'NEWLINE' && b.TYPE !== 'NEWLINE');
    const reasonBtn = realButtons.find((b) =>
      String(b.TEXT || '').includes('причину') || String(b.TEXT || '').includes('Указать')
    );
    assert.ok(reasonBtn !== undefined, '«Указать причину» button must exist');
    assert.equal(reasonBtn.ACTION, 'SEND', 'overdue reason button must be ACTION:SEND');
    assert.equal(reasonBtn.TYPE, undefined, 'overdue reason button must NOT have TYPE field');
    assert.equal(reasonBtn.COMMAND, undefined, 'overdue reason button must NOT have COMMAND field');
    assert.ok(
      typeof reasonBtn.ACTION_VALUE === 'string' && reasonBtn.ACTION_VALUE.match(/^\/reason\s+\d+$/),
      `ACTION_VALUE must be '/reason <id>', got: ${reasonBtn.ACTION_VALUE}`
    );
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

// ─── (c)(d)(e) /api/bot/event v2 parsing ────────────────────────────────────
// We test the route logic inline (mirroring the server.js implementation),
// using the real botCommandHandler + reasonCaptureStore for integration coverage.

/**
 * Build the v2 event handler logic, mirroring server.js /api/bot/event.
 *
 * Handles both:
 *  - urlencoded (prod): body is parsed object with PHP-nested keys
 *    e.g. { event: 'ONIMBOTV2MESSAGEADD', 'data[message][text]': '/reason 42', ... }
 *    After express.urlencoded({ extended:true }) parses it:
 *    { event: 'ONIMBOTV2MESSAGEADD', data: { message: { text: '/reason 42', authorId: '5' }, chat: { dialogId: 'u5' }, user: { id: '5' } }, auth: { application_token: '...' } }
 *  - json (tests): body is already a nested object
 *
 * In both cases after parsing: body.event, body.data.message.text, etc.
 */
function makeV2EventHandler({ jobSecret, reportsStore: rs } = {}) {
  const reasonCaptureStore = createReasonCaptureStore();
  const repliedMessages = [];
  const upsertedReasons = [];

  const bitrixClient = {
    async callMethod(_method, params) {
      repliedMessages.push(params);
      return { ok: true };
    }
  };
  const reasonStore = {
    async upsert(payload) {
      upsertedReasons.push(payload);
      return payload;
    }
  };
  const reportsStore = rs || {
    async getById(id) { return { id, azsId: `azs-${id}` }; }
  };

  const botCmdHandler = createBotCommandHandler({
    bitrixClient,
    reasonStore,
    reasonCaptureStore,
    botId: 777,
    logger: { info: () => {}, warn: () => {} }
  });

  let _botEventUnverifiedWarned = false;
  const warns = [];

  const handler = async (req, res) => {
    // SECURITY GATE (same as server.js)
    const secret = jobSecret !== undefined ? jobSecret : '';
    if (secret) {
      if (req.query.s !== secret) {
        warns.push('rejected: wrong or missing ?s param');
        return res.json({ ok: true, handled: false });
      }
    } else {
      if (!_botEventUnverifiedWarned) {
        _botEventUnverifiedWarned = true;
        warns.push('JOB_SECRET not set — endpoint is UNVERIFIED');
      }
    }

    const body = req.body || {};

    // v2 fields (after urlencoded or json parse, both produce same nested shape)
    const event = String(body.event || body.EVENT || '').toUpperCase();

    // v2 message text: body.data.message.text (fallback: v1 body.data.PARAMS.MESSAGE)
    const messageTextV2 = body.data?.message?.text;
    const messageTextV1 = body.data?.PARAMS?.MESSAGE || body.PARAMS?.MESSAGE;
    const messageText = String(messageTextV2 ?? messageTextV1 ?? '');

    // v2 dialogId: body.data.chat.dialogId (fallback: v1)
    const dialogIdV2 = body.data?.chat?.dialogId;
    const dialogIdV1 = body.data?.PARAMS?.DIALOG_ID || body.PARAMS?.DIALOG_ID;

    // v2 userId: body.data.message.authorId || body.data.user.id (fallback: v1)
    const userIdV2 = body.data?.message?.authorId ?? body.data?.user?.id;
    const userIdV1 = body.data?.PARAMS?.FROM_USER_ID || body.PARAMS?.FROM_USER_ID;
    const userId = Number(userIdV2 ?? userIdV1 ?? 0);

    const dialogId = String(dialogIdV2 ?? dialogIdV1 ?? (userId ? `u${userId}` : ''));

    if (!userId) {
      return res.json({ ok: true, handled: false });
    }

    // Check for /reason <id> in message text (SEND button sends text as message)
    const reasonMatch = messageText.match(/^\/reason\s+(\d+)$/);
    if ((event === 'ONIMBOTV2MESSAGEADD' || event === 'ONIMBOTMESSAGEADD') && reasonMatch) {
      const reportId = Number(reasonMatch[1]);
      let azsId = '';
      try {
        const report = await reportsStore.getById(reportId);
        azsId = String(report?.azsId || '');
      } catch { /* best-effort */ }

      await botCmdHandler.handleCommand({ userId, dialogId, reportId, azsId });
      return res.json({ ok: true, handled: true, action: 'awaiting_reason' });
    }

    // Plain message (possibly reason capture)
    if ((event === 'ONIMBOTV2MESSAGEADD' || event === 'ONIMBOTMESSAGEADD') && messageText) {
      const handled = await botCmdHandler.handleMessage({ userId, dialogId, text: messageText });
      return res.json({ ok: true, handled, action: handled ? 'reason_captured' : 'ignored' });
    }

    return res.json({ ok: true, handled: false });
  };

  return { handler, repliedMessages, upsertedReasons, reasonCaptureStore, warns };
}

function makeRes() {
  const state = { statusCode: 200, payload: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.payload = payload; return this; }
  };
}

function makeReq({ body = {}, query = {} } = {}) {
  return { body, query };
}

// (c) v2 urlencoded ONIMBOTV2MESSAGEADD '/reason 42' → starts awaiting + replies

test('(c) v2 bot/event: ONIMBOTV2MESSAGEADD /reason 42 (json shape) → awaiting + reply', async () => {
  const { handler, repliedMessages, reasonCaptureStore } = makeV2EventHandler({ jobSecret: 'secret123' });

  const req = makeReq({
    body: {
      event: 'ONIMBOTV2MESSAGEADD',
      data: {
        message: { id: 1, text: '/reason 42', authorId: '10', chatId: '100' },
        chat: { id: '100', dialogId: 'u10' },
        user: { id: '10' }
      },
      auth: { application_token: 'tok-abc', domain: 'example.bitrix24.ru' }
    },
    query: { s: 'secret123' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.ok, true);
  assert.equal(res.state.payload?.handled, true, 'must handle /reason 42');
  assert.equal(res.state.payload?.action, 'awaiting_reason');

  // Bot replied «Напишите причину»
  assert.equal(repliedMessages.length, 1, 'must reply once');
  assert.ok(
    String(repliedMessages[0].fields?.message || '').includes('Напишите причину'),
    'reply must say «Напишите причину»'
  );

  // Awaiting state set
  const state = reasonCaptureStore.getAwaiting({ userId: 10, dialogId: 'u10' });
  assert.ok(state !== null, 'awaiting state must be set');
  assert.equal(state.reportId, 42);
});

test('(c) v2 bot/event: /reason 42 with string authorId (urlencoded scalar coerce)', async () => {
  const { handler, reasonCaptureStore } = makeV2EventHandler({ jobSecret: 'sec' });

  // Simulating what express.urlencoded({ extended:true }) produces from
  // a real Bitrix webhook: all scalars arrive as strings
  const req = makeReq({
    body: {
      event: 'ONIMBOTV2MESSAGEADD',
      data: {
        message: { text: '/reason 7', authorId: '99' },  // authorId is string
        chat: { dialogId: 'u99' },
        user: { id: '99' }
      },
      auth: { application_token: 'tok-xyz' }
    },
    query: { s: 'sec' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.handled, true);
  const state = reasonCaptureStore.getAwaiting({ userId: 99, dialogId: 'u99' });
  assert.ok(state !== null, 'awaiting state must be set even with string userId');
  assert.equal(state.reportId, 7);
});

// (d) Follow-up message records reason

test('(d) v2 bot/event: follow-up plain text message records reason', async () => {
  const { handler, upsertedReasons, repliedMessages, reasonCaptureStore } = makeV2EventHandler({ jobSecret: 'sec2' });

  // Prime awaiting state
  reasonCaptureStore.setAwaiting({ userId: 20, dialogId: 'u20', reportId: 55, azsId: 'azs-5' });

  const req = makeReq({
    body: {
      event: 'ONIMBOTV2MESSAGEADD',
      data: {
        message: { text: 'Сломался насос', authorId: '20' },
        chat: { dialogId: 'u20' },
        user: { id: '20' }
      }
    },
    query: { s: 'sec2' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.handled, true);
  assert.equal(res.state.payload?.action, 'reason_captured');

  // Reason was recorded
  assert.equal(upsertedReasons.length, 1);
  assert.equal(upsertedReasons[0].reportId, 55);
  assert.equal(upsertedReasons[0].reasonText, 'Сломался насос');

  // Confirmed in chat
  assert.ok(repliedMessages.length >= 1, 'must reply');
  assert.ok(
    String(repliedMessages[repliedMessages.length - 1].fields?.message || '').includes('Причина принята'),
    'must say «Причина принята»'
  );

  // State cleared
  assert.equal(reasonCaptureStore.getAwaiting({ userId: 20, dialogId: 'u20' }), null);
});

// (e) Wrong/missing ?s fail-closed

test('(e) v2 bot/event: wrong ?s → fail-closed, handled:false', async () => {
  const { handler, repliedMessages, upsertedReasons } = makeV2EventHandler({ jobSecret: 'correct-secret' });

  const req = makeReq({
    body: {
      event: 'ONIMBOTV2MESSAGEADD',
      data: {
        message: { text: '/reason 1', authorId: '5' },
        chat: { dialogId: 'u5' }
      }
    },
    query: { s: 'wrong-secret' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.ok, true);
  assert.equal(res.state.payload?.handled, false, 'must be fail-closed with wrong secret');
  assert.equal(repliedMessages.length, 0);
  assert.equal(upsertedReasons.length, 0);
});

test('(e) v2 bot/event: missing ?s → fail-closed when secret is configured', async () => {
  const { handler, repliedMessages } = makeV2EventHandler({ jobSecret: 'configured-secret' });

  const req = makeReq({
    body: {
      event: 'ONIMBOTV2MESSAGEADD',
      data: {
        message: { text: '/reason 2', authorId: '6' },
        chat: { dialogId: 'u6' }
      }
    },
    query: {} // no ?s
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.ok, true);
  assert.equal(res.state.payload?.handled, false, 'must fail-closed with missing secret');
  assert.equal(repliedMessages.length, 0);
});

test('(e) v2 bot/event: no secret configured → processes request (dev mode)', async () => {
  const { handler, warns } = makeV2EventHandler({ jobSecret: '' });

  const req = makeReq({
    body: {
      event: 'ONIMBOTV2MESSAGEADD',
      data: {
        message: { text: '/reason 3', authorId: '7' },
        chat: { dialogId: 'u7' }
      }
    },
    query: {}
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.handled, true, 'should process when no secret configured');
  assert.ok(warns.some((w) => w.toLowerCase().includes('unverified') || w.toLowerCase().includes('job_secret')),
    'must log a warning about unverified endpoint');
});

// ─── (c) v2 parsing: userId from data.user.id fallback ─────────────────────

test('(c) v2 bot/event: parses userId from data.user.id when authorId absent', async () => {
  const { handler, reasonCaptureStore } = makeV2EventHandler({ jobSecret: 's' });

  const req = makeReq({
    body: {
      event: 'ONIMBOTV2MESSAGEADD',
      data: {
        message: { text: '/reason 10' },  // no authorId
        chat: { dialogId: 'u50' },
        user: { id: '50' }  // userId from data.user.id
      }
    },
    query: { s: 's' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.handled, true);
  const state = reasonCaptureStore.getAwaiting({ userId: 50, dialogId: 'u50' });
  assert.ok(state !== null, 'awaiting must be set using data.user.id as fallback');
});
