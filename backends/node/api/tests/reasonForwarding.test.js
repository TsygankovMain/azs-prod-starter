import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasonForwardingService } from '../src/notifications/reasonForwardingService.js';

const makeClient = (onCall = () => ({})) => ({
  callMethod: async (method, params, context) => onCall(method, params, context)
});

const makeSettings = (chatId = '123') => ({
  report: { responsibleChatId: chatId }
});

test('forward: вызывает imbot.v2.Chat.Message.send с нужными параметрами', async () => {
  let called = null;
  const client = makeClient((method, params) => { called = { method, params }; return {}; });
  const svc = createReasonForwardingService({ bitrixClient: client, botId: 42, logger: { warn: () => {} } });
  await svc.forward({
    settings: makeSettings('777'),
    azsTitle: 'АЗС Луговая',
    operatorName: 'Иван',
    reasonLabel: 'Очередь / много гостей',
    reasonText: null,
    reportStatus: 'expired',
    deadlineAt: new Date('2026-06-04T10:00:00Z').toISOString(),
    timezone: 'Europe/Moscow',
    reportItemId: 99,
    context: {}
  });
  assert.ok(called, 'callMethod должен быть вызван');
  assert.equal(called.method, 'imbot.v2.Chat.Message.send');
  assert.equal(called.params.botId, 42);
  assert.ok(String(called.params.fields.message).includes('АЗС Луговая'));
  assert.ok(String(called.params.fields.message).includes('Иван'));
});

test('forward: не вызывает API если responsibleChatId пуст', async () => {
  let called = false;
  const client = makeClient(() => { called = true; return {}; });
  const svc = createReasonForwardingService({ bitrixClient: client, botId: 42, logger: { warn: () => {} } });
  await svc.forward({
    settings: makeSettings(''),
    azsTitle: 'АЗС', operatorName: 'Иван', reasonLabel: 'Очередь', reasonText: null,
    reportStatus: 'expired', deadlineAt: null, timezone: 'Europe/Moscow',
    reportItemId: 1, context: {}
  });
  assert.equal(called, false, 'API не должен вызываться при пустом chatId');
});

test('forward: best-effort — не бросает при ошибке API', async () => {
  const client = makeClient(() => { throw new Error('BUG-G: bot context broken'); });
  const warns = [];
  const svc = createReasonForwardingService({
    bitrixClient: client, botId: 42,
    logger: { warn: (msg, meta) => warns.push(msg) }
  });
  // Не должен бросить
  await svc.forward({
    settings: makeSettings('777'),
    azsTitle: 'АЗС', operatorName: 'Иван', reasonLabel: 'Очередь', reasonText: null,
    reportStatus: 'expired', deadlineAt: null, timezone: 'Europe/Moscow',
    reportItemId: 1, context: {}
  });
  assert.ok(warns.length > 0, 'должен залогировать предупреждение');
});
