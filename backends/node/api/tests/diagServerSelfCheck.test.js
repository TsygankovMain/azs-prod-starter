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
  // Fix round (боевой инцидент 2026-07-31): голый "disk_timeout" без
  // контекста на боевых бандлах читался так, будто не отвечает сам Bitrix.
  // Сообщение обязано называть сработавшую величину лимита и явно говорить,
  // что это НАШ лимит, а не ответ Bitrix/БД — см. withTimeout в
  // serverSelfCheck.js.
  assert.match(String(out.disk.errorMessage), /40\s*ms/i, 'сообщение должно содержать величину сработавшего таймаута');
  assert.match(String(out.disk.errorMessage), /our own limit/i, 'сообщение должно явно называть лимит нашим');
  assert.doesNotMatch(String(out.disk.errorMessage), /^disk_timeout$/, 'сообщение не должно быть голым кодом без контекста');
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
//
// disk.ok здесь ЗАКОНОМЕРНО false, а не true (в отличие от первой версии
// этого теста, до fix round 2): с тех пор, как probeDisk строит контекст из
// того же самого authContext, что читает probeOauth, зависший/провалившийся
// oauth-контекст — это честное «нечем пробовать» (no_auth_context) для Диска
// тоже, а не независимый успех на пустом {}. БД по-прежнему не зависит от
// oauth-контекста и остаётся здоровой.
test('зависший authContextStore не держит срез дольше своего таймаута', async () => {
  const check = createServerSelfCheck(makeDeps({
    authContextStore: { getLastAdmin: () => new Promise(() => {}) },
    oauthTimeoutMs: 40
  }));
  const startedAt = Date.now();
  const out = await check.run();
  assert.ok(Date.now() - startedAt < 2000, 'срез должен вернуться быстро');
  assert.equal(out.oauth.hasContext, false);
  assert.equal(out.disk.ok, false);
  assert.equal(out.disk.errorMessage, 'no_auth_context');
  // БД не зависит от auth-контекста — зависание oauth-чтения не портит её.
  assert.equal(out.db.ok, true);
});

// --- Fix round 2 (боевой бандл АЗС 174, 2026-07-30): probeDisk звонил с
// пустым {} контекстом, bitrixClient не мог разрешить домен портала и падал
// на "Bitrix portal domain or BITRIX_REST_ENDPOINT is required" ещё до сети —
// disk-проба никогда не могла сказать что-либо о самом Bitrix. Теперь
// probeOauth и probeDisk читают один и тот же контекст один раз, и probeDisk
// строит из него реальный аргумент для callMethod. -----------------------

test('регрессия: с сохранённым контекстом callMethod получает реальный контекст портала, а не {}', async () => {
  let receivedContext = null;
  const check = createServerSelfCheck(makeDeps({
    authContextStore: {
      async getLastAdmin() {
        return {
          key: 'portal:1',
          payload: JSON.stringify({
            domain: 'b24-xc36ra.bitrix24.ru',
            memberId: '9e76288b',
            userId: 498,
            authId: 'REALAUTHID',
            refreshToken: 'REALREFRESHTOKEN'
          }),
          updated_at: new Date(FIXED_NOW - 7_000).toISOString()
        };
      }
    },
    bitrixClient: {
      isConfigured: true,
      async callMethod(method, params, context) {
        receivedContext = context;
        return { result: [] };
      }
    }
  }));
  const out = await check.run();
  assert.equal(out.disk.ok, true);
  // Это и есть страховка от регресса: если кто-то вернёт callMethod('disk.storage.getlist', {}, {})
  // (пустой контекст), receivedContext.domain будет '' или undefined, а не доменом портала.
  assert.ok(receivedContext, 'callMethod должен был получить контекст');
  assert.equal(receivedContext.domain, 'b24-xc36ra.bitrix24.ru');
  assert.equal(receivedContext.memberId, '9e76288b');
  assert.equal(receivedContext.userId, 498);
  assert.equal(receivedContext.authId, 'REALAUTHID');
  assert.equal(receivedContext.refreshToken, 'REALREFRESHTOKEN');
});

test('нет сохранённого контекста: callMethod не вызывается, errorMessage = no_auth_context', async () => {
  let callMethodCalls = 0;
  const check = createServerSelfCheck(makeDeps({
    authContextStore: { async getLastAdmin() { return null; } },
    bitrixClient: {
      isConfigured: true,
      async callMethod() { callMethodCalls += 1; return { result: [] }; }
    }
  }));
  const out = await check.run();
  assert.equal(callMethodCalls, 0, 'callMethod не должен звониться без контекста');
  assert.equal(out.disk.ok, false);
  assert.equal(out.disk.errorCode, null);
  assert.equal(out.disk.errorMessage, 'no_auth_context');
  assert.equal(out.oauth.hasContext, false);
});

test('токен из payload, использованный для реального вызова Диска, не попадает в сериализованный результат', async () => {
  const check = createServerSelfCheck(makeDeps({
    authContextStore: {
      async getLastAdmin() {
        return {
          key: 'portal:1',
          payload: JSON.stringify({
            domain: 'b24-xc36ra.bitrix24.ru',
            memberId: '9e76288b',
            userId: 498,
            authId: 'DISKPROBEAUTHTOKEN',
            refreshToken: 'DISKPROBEREFRESHTOKEN'
          }),
          updated_at: new Date(FIXED_NOW - 7_000).toISOString()
        };
      }
    },
    // Реалистичный успешный вызов — контекст с токенами доходит до
    // callMethod (проверено предыдущим тестом), но в РЕЗУЛЬТАТ пробы
    // (ok/ms/errorCode/errorMessage) он не копируется.
    bitrixClient: { isConfigured: true, async callMethod() { return { result: [] }; } }
  }));
  const out = await check.run();
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('DISKPROBEAUTHTOKEN'), serialized);
  assert.ok(!serialized.includes('DISKPROBEREFRESHTOKEN'), serialized);
  assert.equal(out.oauth.hasAuthId, true);
  assert.equal(out.oauth.hasRefreshToken, true);
});

// --- Fix round (живой инцидент 2026-07-31, ~4200 упавших загрузок за два
// часа на 15 АЗС): найдено сравнением боевых бандлов диагностики с боевыми
// логами сервера во время самого инцидента. Логи сервера показывали
// "Bitrix OAuth refresh failed: wrong_client" 143 раза за пять минут — но
// server_slice.disk во всех 147 бандлах за тот же промежуток писал
// errorCode: null, errorMessage: "disk_timeout", ms: 5000 ровно. Причина:
// bitrixClient (боевой) ретраит транзиентные ошибки по RETRY_BACKOFF_MS =
// [800, 1600, 3200] — 5600 мс сна ещё до сетевых попыток, — а diskTimeoutMs
// пробы по умолчанию 5000 мс. Проба физически не могла пережить цикл
// ретраев основного клиента и обрывалась первой, до того как клиент
// успевал вернуть настоящую ошибку Bitrix. Проба — измерение, а не боевая
// работа: ей нужен первый быстрый честный ответ, а не устойчивость к
// сбоям. Фикс: probeDisk теперь звонит через отдельный diskClient
// (в server.js создаётся с retryBackoffMs: [] и без onTokenRefreshed), а
// bitrixClient остаётся дефолтом для обратной совместимости. -------------

test('Disk-проба звонит через отдельный diskClient, а не через bitrixClient, когда оба заданы', async () => {
  let bitrixClientCalls = 0;
  let diskClientCalls = 0;
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: {
      isConfigured: true,
      async callMethod() {
        bitrixClientCalls += 1;
        throw new Error('bitrixClient не должен звониться из пробы Диска, когда передан diskClient');
      }
    },
    diskClient: {
      async callMethod() {
        diskClientCalls += 1;
        return { result: [] };
      }
    }
  }));
  const out = await check.run();
  assert.equal(diskClientCalls, 1, 'diskClient.callMethod должен быть вызван ровно один раз');
  assert.equal(bitrixClientCalls, 0, 'bitrixClient.callMethod не должен вызываться, когда передан diskClient');
  assert.equal(out.disk.ok, true);
});

test('diskClient без retry: немедленный отказ с wrong_client даёт errorCode: wrong_client, а не таймаут', async () => {
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: {
      isConfigured: true,
      async callMethod() { throw new Error('bitrixClient не должен звониться, когда передан diskClient'); }
    },
    diskClient: {
      // Ровно то, что производит реальный bitrixRestClient после единственной
      // (не повторяемой) попытки авторефреша токена — мгновенный честный
      // отказ, без ретраев и без сна по RETRY_BACKOFF_MS.
      async callMethod() { throw new Error('Bitrix OAuth refresh failed: wrong_client'); }
    }
    // diskTimeoutMs — дефолтные 5000мс намеренно не занижены: тест доказывает,
    // что проба возвращается на порядки быстрее лимита, а не что лимит мал.
  }));
  const startedAt = Date.now();
  const out = await check.run();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(out.disk.ok, false);
  assert.equal(out.disk.errorCode, 'wrong_client');
  assert.ok(
    !/_timeout/.test(String(out.disk.errorMessage)),
    `errorMessage не должен быть таймаутом: ${out.disk.errorMessage}`
  );
  assert.ok(
    elapsedMs < 1000,
    `немедленный отказ должен вернуться быстро, а не спать по RETRY_BACKOFF_MS (заняло ${elapsedMs}мс)`
  );
});

test('diskClient не передан — используется bitrixClient (обратная совместимость)', async () => {
  let bitrixClientCalls = 0;
  const check = createServerSelfCheck(makeDeps({
    bitrixClient: {
      isConfigured: true,
      async callMethod() {
        bitrixClientCalls += 1;
        return { result: [] };
      }
    }
    // diskClient намеренно не передан — старые вызовы createServerSelfCheck
    // (и все тесты выше в этом файле) не должны сломаться.
  }));
  const out = await check.run();
  assert.equal(bitrixClientCalls, 1, 'без diskClient проба обязана звонить через bitrixClient, как раньше');
  assert.equal(out.disk.ok, true);
});
