/**
 * Отправка просроченного отчёта возвращала успех, которого не было.
 *
 * POST /:id/submit не смотрел на статус отчёта: вызывал setReportStatus и
 * отвечал 200 со status: 'done'. Но setReportStatus обновляет строку только
 * при `status NOT IN ('done','expired')` — у просроченного отчёта запись
 * оставалась 'expired'. Оператор видел «отправлено», в системе отчёт
 * оставался несданным, а синхронизация с CRM при этом запускалась.
 *
 * Раньше попасть на просроченный отчёт через «мои отчёты» было нельзя, теперь
 * он там показывается — поэтому отказ должен быть явным и понятным.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

const SETTINGS = {
  azs: { entityTypeId: 1054, fields: { admin: 'ufAdmin', photoSet: 'ufPhotoSet' } },
  report: { entityTypeId: 1058, fields: {}, stages: {} },
  timezone: 'Europe/Moscow'
};

function makeRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this._payload = payload; return payload; }
  };
}

function submitHandler(deps) {
  const router = createReportsRouter({
    dispatchService: {},
    settingsStore: { async read() { return SETTINGS; } },
    bitrixClient: { async callMethod() { return {}; }, async getCrmItem() { return { id: 1, title: 'АЗС 622' }; } },
    notificationService: {
      async notifyReportDone() {},
      async notifyDispatch() {},
      async notifyReportExpired() {}
    },
    authContextStore: { async getLastAdminContext() { return null; } },
    crmSyncJobStore: { async enqueue() {} },
    photoQueueStore: { async accept() {} },
    ...deps
  });
  const layer = router.stack.find((l) => l?.route?.path === '/:id/submit');
  assert.ok(layer, 'маршрут отправки отчёта должен существовать');
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

test('отправка просроченного отчёта отклоняется и статус не трогается', async () => {
  const statusWrites = [];
  const handler = submitHandler({
    reportsStore: {
      async getById() {
        return { id: 42, azsId: '120', adminUserId: 238, status: 'expired', slotKey: '2026-08-11:0643' };
      },
      async listPhotos() { return []; },
      async setReportStatus(args) { statusWrites.push(args); }
    }
  });

  const res = makeRes();
  await handler({
    params: { id: '42' },
    body: {},
    query: {},
    user: { id: 238 },
    accessContext: { capabilities: { reports: true } },
    bitrixContext: {}
  }, res);

  assert.equal(res.statusCode, 409, 'просроченный отчёт нельзя сдать — ожидается 409');
  assert.equal(res._payload?.errorCode, 'report_expired');
  assert.equal(statusWrites.length, 0, 'статус просроченного отчёта не должен переписываться');
});
