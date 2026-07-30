import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSelfCheck } from '../src/diag/serverSelfCheck.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const FIXED_NOW = 1_784_000_000_000;

const makeDeps = (over = {}) => ({
  authContextStore: {
    async getLastAdmin() {
      return {
        key: 'portal:1',
        payload: JSON.stringify({ domain: 'x.bitrix24.ru', memberId: 'm1', authId: 'SECRETAUTH', refreshToken: 'SECRETREFRESH' }),
        updated_at: new Date(FIXED_NOW - 60_000).toISOString()
      };
    }
  },
  bitrixClient: { isConfigured: true, async callMethod() { return { result: [] }; } },
  pool: { async query() { return { rows: [{ ok: 1 }] }; } },
  logger: silentLogger,
  now: () => FIXED_NOW,
  ...over
});

test('здоровый случай: все пробы ок', async () => {
  const check = createServerSelfCheck(makeDeps());
  const out = await check.run();
  assert.equal(out.oauth.hasContext, true);
  assert.equal(out.oauth.domain, 'x.bitrix24.ru');
  assert.equal(out.oauth.ageSec, 60);
  assert.equal(out.disk.ok, true);
  assert.equal(typeof out.disk.ms, 'number');
  assert.equal(out.db.ok, true);
  assert.equal(typeof out.checkedAt, 'string');
});

test('значения токенов в срез не попадают', async () => {
  const check = createServerSelfCheck(makeDeps());
  const serialized = JSON.stringify(await check.run());
  assert.ok(!serialized.includes('SECRETAUTH'), serialized);
  assert.ok(!serialized.includes('SECRETREFRESH'), serialized);
  assert.equal((await check.run()).oauth.hasAuthId, true);
});

test('wrong_client из Диска попадает в срез кодом', async () => {
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: {
      isConfigured: true,
      async callMethod() { throw new Error('Bitrix error: wrong_client — invalid client secret'); }
    }
  }));
  const out = await check.run();
  assert.equal(out.disk.ok, false);
  assert.equal(out.disk.errorCode, 'wrong_client');
});

test('секрет в тексте ошибки Диска чистится', async () => {
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: {
      isConfigured: true,
      async callMethod() { throw new Error('failed: client_secret=LEAKVALUE'); }
    }
  }));
  const out = await check.run();
  assert.ok(!JSON.stringify(out).includes('LEAKVALUE'), JSON.stringify(out));
});

test('зависший Диск не держит срез дольше таймаута', async () => {
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: { isConfigured: true, callMethod: () => new Promise(() => {}) },
    diskTimeoutMs: 40
  }));
  const startedAt = Date.now();
  const out = await check.run();
  assert.ok(Date.now() - startedAt < 2000, 'срез должен вернуться быстро');
  assert.equal(out.disk.ok, false);
  assert.match(String(out.disk.errorMessage), /timeout/);
});

test('падение хранилища контекста не роняет срез', async () => {
  const check = createServerSelfCheck(makeDeps({
    authContextStore: { async getLastAdmin() { throw new Error('db down'); } }
  }));
  const out = await check.run();
  assert.equal(out.oauth.hasContext, false);
  assert.equal(out.db.ok, true);
});

test('битый payload не роняет срез', async () => {
  const check = createServerSelfCheck(makeDeps({
    authContextStore: { async getLastAdmin() { return { payload: 'не json', updated_at: null }; } }
  }));
  const out = await check.run();
  assert.equal(out.oauth.hasContext, true);
  assert.equal(out.oauth.domain, null);
});

test('run никогда не бросает, даже если сломано всё', async () => {
  const check = createServerSelfCheck({
    authContextStore: null, bitrixClient: null, pool: null, logger: silentLogger, now: () => FIXED_NOW
  });
  const out = await check.run();
  assert.equal(out.oauth.hasContext, false);
  assert.equal(out.disk.ok, false);
  assert.equal(out.db.ok, false);
});

// --- Доп. тест (не из брифа): реальный authContextStore из server.js -------
//
// Все три реализации в src/auth/* (файловая, БД, составная) публично отдают
// только getLastAdminContext() → { key, context }, а не getLastAdmin() из
// makeDeps() выше (это приватная деталь db-хранилища внутри
// databaseAuthContextStore.js). Без запасного пути в readLastAdminRow() срез,
// подключённый к реальному стору в server.js, всегда показывал бы
// hasContext: false — тест это фиксирует и не даёт регрессии.
test('реальный интерфейс authContextStore (только getLastAdminContext) тоже читается', async () => {
  const check = createServerSelfCheck(makeDeps({
    authContextStore: {
      async getLastAdminContext() {
        return {
          key: 'm1:x.bitrix24.ru:1',
          context: {
            domain: 'x.bitrix24.ru',
            memberId: 'm1',
            authId: 'SECRETAUTH2',
            refreshToken: 'SECRETREFRESH2',
            updatedAt: new Date(FIXED_NOW - 120_000).toISOString()
          }
        };
      }
    }
  }));
  const out = await check.run();
  assert.equal(out.oauth.hasContext, true);
  assert.equal(out.oauth.domain, 'x.bitrix24.ru');
  assert.equal(out.oauth.ageSec, 120);
  assert.equal(out.oauth.hasAuthId, true);
  assert.equal(out.oauth.hasRefreshToken, true);
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('SECRETAUTH2'), serialized);
  assert.ok(!serialized.includes('SECRETREFRESH2'), serialized);
});

test('authContextStore без getLastAdmin и без getLastAdminContext не роняет срез', async () => {
  const check = createServerSelfCheck(makeDeps({ authContextStore: {} }));
  const out = await check.run();
  assert.equal(out.oauth.hasContext, false);
});

// --- Доп. тест (не из брифа): бриф оборачивает withTimeout только Диск и БД,
// но не чтение authContextStore. По умолчанию (AUTH_CONTEXT_STORE=composite
// в server.js) это тоже поход в БД, поэтому без собственного таймаута зависший
// authContextStore держал бы run() целиком, а не только oauth-пробу.
test('зависший authContextStore не держит срез дольше своего таймаута', async () => {
  const check = createServerSelfCheck(makeDeps({
    authContextStore: { getLastAdmin: () => new Promise(() => {}) },
    oauthTimeoutMs: 40
  }));
  const startedAt = Date.now();
  const out = await check.run();
  assert.ok(Date.now() - startedAt < 2000, 'срез должен вернуться быстро');
  assert.equal(out.oauth.hasContext, false);
  // Диск и БД в этом тесте здоровы — зависание одной пробы не должно портить другие.
  assert.equal(out.disk.ok, true);
  assert.equal(out.db.ok, true);
});
