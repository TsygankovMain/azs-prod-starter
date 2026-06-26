import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportsRouter } from '../src/reports/reportsRoutes.js';

function makeRes() {
  return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this._payload = p; return p; } };
}
function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route?.path === path) {
      return layer.route.stack.filter((l) => !method || l.method === method.toLowerCase() || !l.method)[0]?.handle || null;
    }
  }
  return null;
}
const baseDeps = () => ({
  reportsStore: {
    async listNotSubmittedForDate() { return []; },
    async listSubmittedAzsForDate() { return []; },
    async cancelNotSubmittedForDate() { return 0; },
  },
  dispatchService: {},
  settingsStore: { async read() { return { timezone: 'Europe/Moscow', azs: { entityTypeId: 1, fields: { admin: 'UF_X' } } }; } },
  bitrixClient: { async listCrmItems() { return []; } },
  notificationService: { async notify() {} },
  authContextStore: {},
  crmSyncJobStore: {},
  dispatchPlanStore: { async ensureSchema() {}, upsertPlanned() {}, async listByDate() { return []; } },
});

test('POST /today/reissue: 403 без capabilities.settings', async () => {
  const router = createReportsRouter(baseDeps());
  const handler = getHandler(router, 'post', '/today/reissue');
  assert.ok(handler, 'route exists');
  const req = { body: {}, accessContext: { capabilities: { reviewer: true } }, bitrixContext: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('POST /today/reissue: dryRun возвращает счётчики для админа', async () => {
  const router = createReportsRouter(baseDeps());
  const handler = getHandler(router, 'post', '/today/reissue');
  const req = { body: { dryRun: true }, accessContext: { capabilities: { settings: true } }, bitrixContext: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res._payload.ok, true);
  assert.equal(res._payload.dryRun, true);
  assert.equal(res._payload.affected, 0);
  assert.equal(res._payload.planDate?.length, 10);
});
