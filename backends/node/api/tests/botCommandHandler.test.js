/**
 * BUG-019: COMMAND-кнопки бота — тесты для botCommandHandler и reasonCaptureStore.
 *
 * TDD: тесты написаны ПЕРВЫМИ — все должны упасть до реализации.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── reasonCaptureStore ───────────────────────────────────────────────────────
import { createReasonCaptureStore } from '../src/notifications/reasonCaptureStore.js';

test('reasonCaptureStore: setAwaiting stores state; getAwaiting returns it', () => {
  const store = createReasonCaptureStore();
  store.setAwaiting({ userId: 1, dialogId: 'u1', reportId: 42, azsId: 'azs-7' });
  const state = store.getAwaiting({ userId: 1, dialogId: 'u1' });
  assert.deepEqual(state, { reportId: 42, azsId: 'azs-7' });
});

test('reasonCaptureStore: getAwaiting returns null when no state', () => {
  const store = createReasonCaptureStore();
  const state = store.getAwaiting({ userId: 99, dialogId: 'u99' });
  assert.equal(state, null);
});

test('reasonCaptureStore: clearAwaiting removes state', () => {
  const store = createReasonCaptureStore();
  store.setAwaiting({ userId: 2, dialogId: 'u2', reportId: 10, azsId: 'azs-1' });
  store.clearAwaiting({ userId: 2, dialogId: 'u2' });
  assert.equal(store.getAwaiting({ userId: 2, dialogId: 'u2' }), null);
});

test('reasonCaptureStore: setAwaiting overwrites previous state', () => {
  const store = createReasonCaptureStore();
  store.setAwaiting({ userId: 3, dialogId: 'u3', reportId: 1, azsId: 'azs-a' });
  store.setAwaiting({ userId: 3, dialogId: 'u3', reportId: 2, azsId: 'azs-b' });
  const state = store.getAwaiting({ userId: 3, dialogId: 'u3' });
  assert.equal(state.reportId, 2);
  assert.equal(state.azsId, 'azs-b');
});

// ─── botCommandHandler ────────────────────────────────────────────────────────
import { createBotCommandHandler } from '../src/notifications/botCommandHandler.js';

// ─── helper: build a minimal handler and extract calls ────────────────────────

const makeHandler = (overrides = {}) => {
  const repliedMessages = [];
  const upsertedReasons = [];
  const store = createReasonCaptureStore();

  const bitrixClient = {
    callMethod: async (_method, params) => {
      repliedMessages.push(params);
      return { ok: true };
    },
    ...(overrides.bitrixClient || {})
  };

  const reasonStore = {
    upsert: async (payload) => {
      upsertedReasons.push(payload);
      return payload;
    },
    ...(overrides.reasonStore || {})
  };

  const handler = createBotCommandHandler({
    bitrixClient,
    reasonStore,
    reasonCaptureStore: store,
    botId: 777,
    logger: { info: () => {}, warn: () => {} }
  });

  return { handler, repliedMessages, upsertedReasons, store };
};

// ─── quick reason buttons (getReasons) ───────────────────────────────────────

test('handleCommand: with getReasons attaches a keyboard of reason buttons (ACTION:SEND)', async () => {
  const replies = [];
  const handler = createBotCommandHandler({
    bitrixClient: { callMethod: async (_m, p) => { replies.push(p); return {}; } },
    reasonStore: { upsert: async (p) => p },
    reasonCaptureStore: createReasonCaptureStore(),
    botId: 777,
    logger: { info: () => {}, warn: () => {} },
    getReasons: async () => ([
      { code: 'queue', label: 'Очередь на мойке' },
      { code: 'staff', label: 'Нет сотрудника' },
      { code: 'other', label: 'Другое' }
    ])
  });

  await handler.handleCommand({ userId: 10, dialogId: 'u10', reportId: 55, azsId: 'a' });

  assert.equal(replies.length, 1);
  const kb = replies[0].fields?.keyboard;
  assert.ok(kb && Array.isArray(kb.BUTTONS), 'reply must carry a keyboard with BUTTONS');
  const queueBtn = kb.BUTTONS.find(b => b.TEXT === 'Очередь на мойке');
  assert.ok(queueBtn, 'a button per reason label');
  assert.equal(queueBtn.ACTION, 'SEND', 'reason buttons must be ACTION:SEND');
  assert.equal(queueBtn.ACTION_VALUE, 'Очередь на мойке', 'ACTION_VALUE is the label (sent as message)');
  assert.ok(String(replies[0].fields?.message || '').includes('Выберите причину'), 'prompt invites choosing');
});

test('handleMessage: a tapped catalog label is recorded with its reasonCode (not other)', async () => {
  const store = createReasonCaptureStore();
  const upserts = [];
  const captured = [];
  const handler = createBotCommandHandler({
    bitrixClient: { callMethod: async () => ({}) },
    reasonStore: { upsert: async (p) => { upserts.push(p); return p; } },
    reasonCaptureStore: store,
    logger: { info: () => {}, warn: () => {} },
    getReasons: async () => ([{ code: 'queue', label: 'Очередь на мойке' }, { code: 'other', label: 'Другое' }]),
    onReasonCaptured: async (p) => { captured.push(p); }
  });
  store.setAwaiting({ userId: 1, dialogId: 'u1', reportId: 9, azsId: 'a' });

  await handler.handleMessage({ userId: 1, dialogId: 'u1', text: 'Очередь на мойке' });

  assert.equal(upserts[0].reasonCode, 'queue', 'matched label → its catalog code');
  assert.equal(captured[0].reasonCode, 'queue', 'hook also gets the resolved code');
});

test('handleMessage: free text that matches no label stays reasonCode=other', async () => {
  const store = createReasonCaptureStore();
  const upserts = [];
  const handler = createBotCommandHandler({
    bitrixClient: { callMethod: async () => ({}) },
    reasonStore: { upsert: async (p) => { upserts.push(p); return p; } },
    reasonCaptureStore: store,
    logger: { info: () => {}, warn: () => {} },
    getReasons: async () => ([{ code: 'queue', label: 'Очередь на мойке' }])
  });
  store.setAwaiting({ userId: 2, dialogId: 'u2', reportId: 9, azsId: 'a' });

  await handler.handleMessage({ userId: 2, dialogId: 'u2', text: 'сломалась касса' });

  assert.equal(upserts[0].reasonCode, 'other');
  assert.ok(String(upserts[0].reasonText).includes('касса'));
});

// ─── handleCommand ────────────────────────────────────────────────────────────

test('handleCommand: replies «Напишите причину» and sets awaiting state', async () => {
  const { handler, repliedMessages, store } = makeHandler();

  await handler.handleCommand({
    userId: 10,
    dialogId: 'u10',
    reportId: 55,
    azsId: 'azs-5'
  });

  // Bot replied in chat
  assert.equal(repliedMessages.length, 1, 'must reply once');
  const reply = repliedMessages[0];
  assert.ok(String(reply.fields?.message || '').includes('Напишите причину'), 'reply text must mention «Напишите причину»');
  assert.equal(reply.dialogId, 'u10', 'reply must go to the same dialog');

  // State is remembered
  const state = store.getAwaiting({ userId: 10, dialogId: 'u10' });
  assert.ok(state !== null, 'awaiting state must be set');
  assert.equal(state.reportId, 55);
  assert.equal(state.azsId, 'azs-5');
});

// ─── handleMessage ────────────────────────────────────────────────────────────

test('handleMessage: when awaiting, records reason and replies «Причина принята»', async () => {
  const { handler, repliedMessages, upsertedReasons, store } = makeHandler();

  // Prime the state manually
  store.setAwaiting({ userId: 20, dialogId: 'u20', reportId: 99, azsId: 'azs-9' });

  const handled = await handler.handleMessage({
    userId: 20,
    dialogId: 'u20',
    text: 'Не успел — слишком много машин'
  });

  assert.equal(handled, true, 'handleMessage must return true when state was awaiting');

  // Reason recorded
  assert.equal(upsertedReasons.length, 1, 'must upsert reason exactly once');
  const reason = upsertedReasons[0];
  assert.equal(reason.reportId, 99);
  assert.equal(reason.azsId, 'azs-9');
  assert.equal(reason.adminUserId, 20);
  assert.ok(String(reason.reasonText).includes('Не успел'), 'reasonText must contain message text');
  assert.equal(reason.source, 'bot');

  // Confirmation message
  assert.ok(repliedMessages.length >= 1, 'must send confirmation reply');
  const confirmation = repliedMessages[repliedMessages.length - 1];
  assert.ok(String(confirmation.fields?.message || '').includes('Причина принята'), '«Причина принята» must be in reply');

  // State cleared
  assert.equal(store.getAwaiting({ userId: 20, dialogId: 'u20' }), null, 'awaiting state must be cleared after capture');
});

test('handleMessage: when NOT awaiting, returns false and does nothing', async () => {
  const { handler, repliedMessages, upsertedReasons } = makeHandler();

  const handled = await handler.handleMessage({
    userId: 30,
    dialogId: 'u30',
    text: 'Просто какое-то сообщение'
  });

  assert.equal(handled, false, 'handleMessage must return false when not awaiting');
  assert.equal(repliedMessages.length, 0, 'must NOT reply');
  assert.equal(upsertedReasons.length, 0, 'must NOT upsert reason');
});

test('handleMessage: empty text is ignored even when awaiting', async () => {
  const { handler, store, repliedMessages, upsertedReasons } = makeHandler();
  store.setAwaiting({ userId: 40, dialogId: 'u40', reportId: 1, azsId: 'azs-1' });

  const handled = await handler.handleMessage({
    userId: 40,
    dialogId: 'u40',
    text: '   '
  });

  // State still awaiting — we did not consume a blank message
  assert.equal(handled, false, 'must return false for blank text');
  assert.equal(upsertedReasons.length, 0);
  assert.equal(repliedMessages.length, 0);
  assert.ok(store.getAwaiting({ userId: 40, dialogId: 'u40' }) !== null, 'state must remain when text is blank');
});

// ─── onReasonCaptured hook: CRM write + forward parity with the app path ───────

test('handleMessage: invokes onReasonCaptured with reportId/azsId/text after capturing', async () => {
  const store = createReasonCaptureStore();
  const captured = [];
  const handler = createBotCommandHandler({
    bitrixClient: { callMethod: async () => ({ ok: true }) },
    reasonStore: { upsert: async (p) => p },
    reasonCaptureStore: store,
    botId: 777,
    logger: { info: () => {}, warn: () => {} },
    onReasonCaptured: async (payload) => { captured.push(payload); }
  });
  store.setAwaiting({ userId: 20, dialogId: 'u20', reportId: 99, azsId: 'azs-9' });

  await handler.handleMessage({ userId: 20, dialogId: 'u20', text: 'Очередь на мойку' });

  assert.equal(captured.length, 1, 'onReasonCaptured must fire once after capture');
  assert.equal(captured[0].reportId, 99);
  assert.equal(captured[0].azsId, 'azs-9');
  assert.ok(String(captured[0].reasonText).includes('Очередь'), 'reasonText must reach the hook');
});

test('handleMessage: does NOT invoke onReasonCaptured when not awaiting', async () => {
  const store = createReasonCaptureStore();
  const captured = [];
  const handler = createBotCommandHandler({
    bitrixClient: { callMethod: async () => ({ ok: true }) },
    reasonStore: { upsert: async (p) => p },
    reasonCaptureStore: store,
    logger: { info: () => {}, warn: () => {} },
    onReasonCaptured: async (p) => { captured.push(p); }
  });

  const handled = await handler.handleMessage({ userId: 1, dialogId: 'u1', text: 'случайное сообщение' });
  assert.equal(handled, false);
  assert.equal(captured.length, 0, 'hook must not fire when not awaiting');
});

test('handleMessage: a failing onReasonCaptured does not break the «Принято» reply', async () => {
  const store = createReasonCaptureStore();
  const replies = [];
  const handler = createBotCommandHandler({
    bitrixClient: { callMethod: async (_m, p) => { replies.push(p); return {}; } },
    reasonStore: { upsert: async (p) => p },
    reasonCaptureStore: store,
    onReasonCaptured: async () => { throw new Error('forward boom'); },
    logger: { info: () => {}, warn: () => {} }
  });
  store.setAwaiting({ userId: 5, dialogId: 'u5', reportId: 7, azsId: 'a' });

  const handled = await handler.handleMessage({ userId: 5, dialogId: 'u5', text: 'причина' });
  assert.equal(handled, true, 'capture still succeeds even if side-effects fail');
  assert.ok(
    replies.some((r) => String(r.fields?.message || '').includes('Причина принята')),
    'confirmation reply must still be sent'
  );
});
