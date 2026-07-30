import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactText as serverRedactText,
  redactUrl as serverRedactUrl,
  redactHeaders as serverRedactHeaders,
  sanitizeBundle as serverSanitizeBundle,
  MAX_BUNDLE_BYTES as SERVER_MAX_BUNDLE_BYTES
} from '../src/diag/sanitizeBundle.js';

// Real client imports from frontend
import {
  redactText as clientRedactText,
  redactUrl as clientRedactUrl,
  redactHeaders as clientRedactHeaders
} from '../../../../frontend/app/utils/diag/redact.ts';
import { buildBundle as clientBuildBundle, MAX_BUNDLE_BYTES as CLIENT_MAX_BUNDLE_BYTES } from '../../../../frontend/app/utils/diag/buildBundle.ts';

const URL_CORPUS = [
  '/x?refresh_id=LEAKME', '/x?session=LEAKME', '/x?private_token=LEAKME',
  '/x?client_secret=LEAKME', '/x?token=LEAKME', '/x?access_token=LEAKME',
  '/x?sessid=LEAKME', '/x?password=LEAKME', '/x?api-key=LEAKME',
  'https://o.test/a?x=1#access_token=LEAKME&token_type=bearer',
  '/cb#refresh_id=LEAKME',
  '/api/reports?azsId=548&reportId=12345',
  ''
];

const TEXT_CORPUS = [
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh',
  'Bearer LEAK', 'Basic LEAK', 'Bearer LEAKME12',
  'client_secret=LEAKME',
  'refresh_id=LEAKME',
  'Authorization: Bearer eyJ.LEAKME',
  'POST /api?token=SECRET failed'
];

const HEADER_CORPUS = [
  { Authorization: 'LEAKME' }, { cookie: 'LEAKME' }, { 'set-cookie': 'LEAKME' },
  { 'x-api-key': 'LEAKME' }, { 'x-auth-token': 'LEAKME' }, { 'x-refresh-token': 'LEAKME' },
  { password: 'LEAKME' }, { client_secret: 'LEAKME' }, { secret: 'LEAKME' },
  { 'x-session-id': 'LEAKME' }, { 'x-pwd': 'LEAKME' },
  { 'X-Ok': 'keep', 'content-type': 'application/json' }
];

test('клиент и сервер чистят URL одинаково', () => {
  for (const input of URL_CORPUS) {
    assert.equal(serverRedactUrl(input), clientRedactUrl(input), `расхождение на ${JSON.stringify(input)}`);
  }
});

test('клиент и сервер чистят заголовки одинаково', () => {
  for (const input of HEADER_CORPUS) {
    assert.deepEqual(serverRedactHeaders(input), clientRedactHeaders(input), `расхождение на ${JSON.stringify(input)}`);
  }
});

test('клиент и сервер одинаково чистят свободный текст', () => {
  for (const input of TEXT_CORPUS) {
    assert.equal(serverRedactText(input), clientRedactText(input), `redactText разошёлся: ${input}`);
  }
});

test('ни один слой не пропускает секрет в URL или заголовках', () => {
  const leaks = [];
  for (const input of URL_CORPUS) {
    if (!input.includes('LEAKME')) continue;
    for (const [layer, fn] of [['клиент', clientRedactUrl], ['сервер', serverRedactUrl]]) {
      if (fn(input).includes('LEAKME')) leaks.push(`  ${layer} url: ${input} -> ${fn(input)}`);
    }
  }
  for (const input of HEADER_CORPUS) {
    for (const [layer, fn] of [['клиент', clientRedactHeaders], ['сервер', serverRedactHeaders]]) {
      const out = JSON.stringify(fn(input));
      if (out.includes('LEAKME')) leaks.push(`  ${layer} headers: ${JSON.stringify(input)} -> ${out}`);
    }
  }
  for (const input of TEXT_CORPUS) {
    if (!input.includes('LEAK')) continue;
    for (const [layer, fn] of [['клиент', clientRedactText], ['сервер', serverRedactText]]) {
      if (fn(input).includes('LEAK')) leaks.push(`  ${layer} text: ${input} -> ${fn(input)}`);
    }
  }
  assert.equal(leaks.length, 0, `Утечки:\n${leaks.join('\n')}`);
});

test('редакция URL сохраняет диагностически полезные параметры', () => {
  for (const fn of [clientRedactUrl, serverRedactUrl]) {
    const out = fn('/api/reports?azsId=548&reportId=12345&token=SECRETV');
    assert.ok(!out.includes('SECRETV'), out);
    assert.ok(out.includes('azsId=548') && out.includes('reportId=12345'), out);
  }
});

test('оба слоя не искажают безобидную прозу', () => {
  for (const fn of [clientRedactText, serverRedactText]) {
    for (const msg of [
      'Не удалось загрузить фото: сеть недоступна (azsId=548, попытка 2)',
      'refresh token истёк',
      'Ошибка авторизации'
    ]) {
      assert.equal(fn(msg), msg);
    }
  }
});

// Корпус враждебных значений: не строки. Именно на них слои разъехались —
// сервер перестал бросать, клиент продолжал, и строковый корпус этого
// увидеть не мог.
const HOSTILE_INPUTS = [
  { toString: 'pwned' },
  { valueOf: 'x', toString: 'y' },
  Object.create(null),
  [1, 2],
  { a: 1 },
  42,
  true,
  null,
  undefined,
  ''
];

// Безопасное описание враждебного значения для текста ассерта. String(value)
// сам бросает на {toString:'pwned'}-подобных объектах — describeHostile нужен,
// чтобы падение случилось на СРАВНЕНИИ, а не на построении сообщения о нём.
const describeHostile = (value) => {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
};

test('ни один слой не бросает на враждебном входе', () => {
  const thrown = [];
  for (const input of HOSTILE_INPUTS) {
    for (const [layer, fn, name] of [
      ['клиент', clientRedactText, 'redactText'], ['сервер', serverRedactText, 'redactText'],
      ['клиент', clientRedactUrl, 'redactUrl'], ['сервер', serverRedactUrl, 'redactUrl']
    ]) {
      try { fn(input); } catch (error) {
        thrown.push(`  ${layer} ${name}(${describeHostile(input)}): ${error.message}`);
      }
    }
  }
  for (const input of HOSTILE_INPUTS) {
    for (const [layer, fn] of [['клиент', clientRedactHeaders], ['сервер', serverRedactHeaders]]) {
      try { fn({ 'x-custom': input }); } catch (error) {
        thrown.push(`  ${layer} redactHeaders(x-custom=${describeHostile(input)}): ${error.message}`);
      }
    }
  }
  assert.equal(thrown.length, 0, `Броски на враждебном входе:\n${thrown.join('\n')}`);
});

test('слои одинаково обрабатывают враждебный вход', () => {
  for (const input of HOSTILE_INPUTS) {
    assert.equal(serverRedactText(input), clientRedactText(input), `redactText разошёлся на ${describeHostile(input)}`);
    assert.equal(serverRedactUrl(input), clientRedactUrl(input), `redactUrl разошёлся на ${describeHostile(input)}`);
    assert.deepEqual(
      serverRedactHeaders({ 'x-custom': input }),
      clientRedactHeaders({ 'x-custom': input }),
      `redactHeaders разошёлся на ${describeHostile(input)}`
    );
  }
});

// --- Fix round (ревью, S4) ---------------------------------------------------
//
// Всё выше сравнивает только низкоуровневые redactText/redactUrl/redactHeaders.
// Этого недостаточно: если завтра кто-то заведёт седьмое редактируемое поле
// (например, в buildBundle.ts) и забудет прогнать его через redact* — или
// прогонит только на одном слое, — приведённые выше тесты этого не заметят,
// потому что сами вызывают redact* напрямую, в обход buildBundle/sanitizeBundle.
// Ниже — два теста, которые гоняют ПОЛНЫЙ пайплайн обоих слоёв.

test('MAX_BUNDLE_BYTES одинаков на клиенте и сервере', () => {
  assert.equal(CLIENT_MAX_BUNDLE_BYTES, SERVER_MAX_BUNDLE_BYTES);
  assert.equal(CLIENT_MAX_BUNDLE_BYTES, 262_144);
});

const SECRET = 'LEAKME-PARITY';

/**
 * Секрет посажен в КАЖДОЕ поле, которое сегодня проходит через redact* хотя
 * бы на одном слое: net.url/net.headers, errors.message/errors.stack/
 * errors.source, uploads.message, queue.slots.error, app.route. Полное
 * покрытие — форма самого этого списка одновременно и есть проверка: если
 * добавить восьмое поле только в buildBundle.ts или только в
 * sanitizeBundle.js, тест ниже либо перестанет ловить утечку на одном из
 * слоёв (assert по слою), либо (при добавлении сюда) сразу покажет расхождение.
 */
const buildLeakyRawBundle = () => ({
  v: 1,
  diagSessionId: 'sess-parity',
  sentAt: '2026-07-30T09:00:00.000Z',
  trigger: 'button',
  app: { build: 'dev', route: `/admin/1?token=${SECRET}`, isDemo: false },
  user: { userId: 498, azsId: '548', reportId: 12345, role: 'azs_admin' },
  device: {
    userAgent: 'UA', deviceMemory: 4, hardwareConcurrency: 8,
    screen: { w: 390, h: 844, dpr: 3 }, language: 'ru', platform: 'Android'
  },
  network: { onLine: true, effectiveType: '3g', downlink: 0.4, rtt: 1200, saveData: false },
  probe: { echoBytes: 1000, echoMs: 100, echoKbps: 80, pingMsMedian: 50, pingLoss: 0 },
  startup: { navigationMs: 100, ttfbMs: 50, domContentLoadedMs: 200, resourceCount: 5 },
  queue: {
    activeCount: 0, maxConcurrency: 2, workerSessionId: 1,
    slots: [{
      key: 'p1', confirmed: true, uploadState: 'error', uploaded: false,
      fileSize: 1, fileType: 'image/jpeg', error: `auth=${SECRET}`
    }]
  },
  uploads: [{
    photoCode: 'p1', fileSize: 1, fileType: 'image/jpeg', exifTakenAt: null,
    startedAt: '2026-07-30T09:00:00.000Z', durationMs: 1, outcome: 'error',
    httpStatus: 502, errorCode: 'X', retryable: true, attempt: 1,
    message: `sessid=${SECRET}`
  }],
  net: [{
    url: `/api/reports?token=${SECRET}`, method: 'GET', status: 200,
    startedAt: '2026-07-30T09:00:00.000Z', durationMs: 10, reqBytes: 0, resBytes: 0,
    headers: { Authorization: `Bearer ${SECRET}`, 'x-ok': 'keep' }
  }],
  errors: [{
    kind: 'onerror', message: `token=${SECRET}`, stack: `Error: token=${SECRET}\n  at x`,
    source: `https://app.test/app.js?session=${SECRET}`, line: 1, col: 2,
    at: '2026-07-30T09:00:00.000Z'
  }],
  b24: [],
  dropped: { net: 0, errors: 0, uploads: 0 }
});

test('полный бандл: секрет во всех редактируемых полях не проходит НИ через один слой', () => {
  const clientBundle = clientBuildBundle(buildLeakyRawBundle());
  const serverResult = serverSanitizeBundle(buildLeakyRawBundle());

  assert.equal(serverResult.ok, true, `sanitizeBundle отклонил валидный бандл: ${serverResult.error}`);

  const clientJson = JSON.stringify(clientBundle);
  const serverJson = JSON.stringify(serverResult.bundle);

  assert.ok(!clientJson.includes(SECRET), `клиентский слой (buildBundle.ts) пропустил секрет:\n${clientJson}`);
  assert.ok(!serverJson.includes(SECRET), `серверный слой (sanitizeBundle.js) пропустил секрет:\n${serverJson}`);

  // Нередактируемые, но диагностически полезные поля должны пережить оба слоя
  // не тронутыми — иначе тест выше можно было бы "починить", просто выкинув
  // все поля целиком.
  assert.ok(clientJson.includes('/admin/1'), clientJson);
  assert.ok(serverJson.includes('/admin/1'), serverJson);
});
