import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBundle, generateDiagCode, DIAG_CODE_ALPHABET, redactText } from '../src/diag/sanitizeBundle.js';

const validBundle = () => ({
  v: 1,
  diagSessionId: 'sess-1',
  sentAt: '2026-07-30T09:00:00.000Z',
  trigger: 'button',
  net: [{ url: '/api/x?token=abc', method: 'GET', status: 200, headers: { Authorization: 'Bearer s', 'X-Ok': 'k' } }],
  uploads: [],
  errors: [],
  b24: []
});

test('отклоняет не-объект', () => {
  assert.equal(sanitizeBundle(null).ok, false);
  assert.equal(sanitizeBundle('str').ok, false);
});

test('отклоняет неизвестную версию', () => {
  const res = sanitizeBundle({ ...validBundle(), v: 99 });
  assert.equal(res.ok, false);
  assert.match(res.error, /version/i);
});

test('отклоняет неизвестный trigger', () => {
  const res = sanitizeBundle({ ...validBundle(), trigger: 'hack' });
  assert.equal(res.ok, false);
  assert.match(res.error, /trigger/i);
});

test('повторно скрывает секреты, даже если клиент этого не сделал', () => {
  const res = sanitizeBundle(validBundle());
  assert.equal(res.ok, true);
  assert.equal(res.bundle.net[0].headers.Authorization, '***');
  assert.equal(res.bundle.net[0].headers['X-Ok'], 'k');
  assert.ok(!JSON.stringify(res.bundle).includes('Bearer s'));
  assert.ok(!JSON.stringify(res.bundle).includes('token=abc'));
});

test('чистит секреты в свободном тексте ошибок, загрузок и очереди', () => {
  const raw = validBundle();
  raw.errors = [{ kind: 'onerror', message: 'POST /api/x?token=LEAK failed', stack: 'Error: sessid=LEAK\n  at f' }];
  raw.uploads = [{ photoCode: 'p1', message: 'auth=LEAK' }];
  raw.queue = { activeCount: 0, maxConcurrency: 2, workerSessionId: 1, slots: [{ key: 'p1', error: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc' }] };
  const res = sanitizeBundle(raw);
  assert.equal(res.ok, true);
  const serialized = JSON.stringify(res.bundle);
  assert.ok(!serialized.includes('LEAK'), serialized);
  assert.ok(!serialized.includes('eyJhbGciOiJIUzI1NiJ9'), serialized);
});

test('серверная чистка закрывает те же формы ключей, что и клиентская', () => {
  const forms = [
    'client_secret=LEAK', 'client-secret=LEAK', 'password=LEAK', 'auth_id=LEAK',
    'api-key=LEAK', 'apikey=LEAK', 'refresh-token=LEAK', 'session-id=LEAK',
    'secret=LEAK', 'pwd=LEAK', 'id_token=LEAK'
  ];
  for (const form of forms) {
    const raw = validBundle();
    raw.errors = [{ kind: 'onerror', message: form }];
    const res = sanitizeBundle(raw);
    assert.equal(res.ok, true, form);
    assert.ok(!JSON.stringify(res.bundle).includes('LEAK'), `утечка: ${form}`);
  }
});

test('значение с запятой маскируется целиком и на сервере', () => {
  const raw = validBundle();
  raw.errors = [{ kind: 'onerror', message: 'token=abc123,def456' }];
  const serialized = JSON.stringify(sanitizeBundle(raw).bundle);
  assert.ok(!serialized.includes('abc123'), serialized);
  assert.ok(!serialized.includes('def456'), serialized);
});

test('отсутствующие массивы не роняют санитизацию', () => {
  const raw = validBundle();
  delete raw.errors;
  delete raw.uploads;
  delete raw.queue;
  const res = sanitizeBundle(raw);
  assert.equal(res.ok, true);
  assert.deepEqual(res.bundle.errors, []);
  assert.deepEqual(res.bundle.uploads, []);
});

test('отклоняет бандл больше потолка', () => {
  const big = validBundle();
  big.errors = Array.from({ length: 5000 }, () => ({ kind: 'onerror', message: 'x'.repeat(200) }));
  const res = sanitizeBundle(big);
  assert.equal(res.ok, false);
  assert.match(res.error, /too_large/);
});

test('возвращает размер в байтах', () => {
  const res = sanitizeBundle(validBundle());
  assert.equal(res.ok, true);
  assert.equal(typeof res.sizeBytes, 'number');
  assert.ok(res.sizeBytes > 0);
});

test('generateDiagCode: 6 символов из безопасного алфавита', () => {
  const code = generateDiagCode(Buffer.from([0, 1, 2, 3, 4, 5]));
  assert.equal(code.length, 6);
  for (const ch of code) assert.ok(DIAG_CODE_ALPHABET.includes(ch), `${ch} вне алфавита`);
});

test('generateDiagCode: алфавит без похожих символов', () => {
  for (const ch of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!DIAG_CODE_ALPHABET.includes(ch), `${ch} не должен входить в алфавит`);
  }
});

test('redactText закрывает все формы, найденные проверкой исполнением', () => {
  const cases = [
    'client_secret=LEAKME', 'client-secret=LEAKME', 'password=LEAKME', 'passwd=LEAKME',
    'auth_id=LEAKME', 'authid=LEAKME', 'REFRESH_ID=LEAKME', 'refresh_id: LEAKME',
    'api-key=LEAKME', 'apikey=LEAKME', 'private_token=LEAKME', 'bot_token=LEAKME',
    'session=LEAKME', 'session-id=LEAKME', 'Cookie: connect.sid=LEAKME',
    'secret=LEAKME', 'pwd=LEAKME', 'id_token=LEAKME'
  ];
  for (const c of cases) {
    assert.ok(!redactText(c).includes('LEAKME'), `утечка: ${c} -> ${redactText(c)}`);
  }
});

test('redactText: Authorization + Bearer не оставляют токен', () => {
  for (const c of [
    'at fetch (Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh)',
    'headers: {authorization: Bearer SUPERSECRETJWT}',
    'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh',
    'basic YWRtaW46cGFzc3dvcmQ='
  ]) {
    const out = redactText(c);
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), `утечка: ${c} -> ${out}`);
    assert.ok(!out.includes('SUPERSECRETJWT'), `утечка: ${c} -> ${out}`);
    assert.ok(!out.includes('YWRtaW46cGFzc3dvcmQ'), `утечка: ${c} -> ${out}`);
  }
});

test('redactText: значение с запятой маскируется целиком', () => {
  const out = redactText('token=abc123,def456');
  assert.ok(!out.includes('abc123'), out);
  assert.ok(!out.includes('def456'), out);
});

test('redactText: полезный контекст и проза сохраняются', () => {
  const out = redactText('POST /api/reports?token=SECRET&azsId=548 failed 502');
  assert.ok(!out.includes('SECRET'), out);
  assert.ok(out.includes('azsId=548') && out.includes('502'), out);
  assert.equal(redactText('refresh token истёк'), 'refresh token истёк');
});

test('sanitizeBundle: секрет не доезжает ни через один текстовый путь', () => {
  const raw = validBundle();
  raw.net = [{ url: '/api/x?token=LEAKME', headers: { Authorization: 'Bearer LEAKME' } }];
  raw.errors = [{ kind: 'onerror', message: 'client_secret=LEAKME', stack: 'auth_id=LEAKME' }];
  raw.uploads = [{ photoCode: 'p', message: 'REFRESH_ID=LEAKME' }];
  raw.queue = { activeCount: 0, maxConcurrency: 2, workerSessionId: 1, slots: [{ key: 'p', error: 'Bearer eyJ.LEAKME' }] };
  const res = sanitizeBundle(raw);
  assert.equal(res.ok, true);
  assert.ok(!JSON.stringify(res.bundle).includes('LEAKME'), JSON.stringify(res.bundle));
});

test('битые v и trigger отклоняются, а не роняют функцию', () => {
  for (const bad of [
    { v: { valueOf: 'x', toString: 'y' }, trigger: 'button' },
    { v: 1, trigger: { toString: 'z' } },
    { v: [1], trigger: 'button' },
    { v: 1, trigger: ['button'] }
  ]) {
    const res = sanitizeBundle(bad);
    assert.equal(res.ok, false, JSON.stringify(bad));
  }
});

test('строковая версия принимается', () => {
  const raw = validBundle();
  raw.v = '1';
  assert.equal(sanitizeBundle(raw).ok, true);
});

test('секрет во фрагменте URL не доезжает', () => {
  const raw = validBundle();
  raw.net = [{ url: 'https://o.test/a?x=1#access_token=LEAKME', headers: {} }];
  assert.ok(!JSON.stringify(sanitizeBundle(raw).bundle).includes('LEAKME'));
});

test('секрет в расширенных query-ключах не доезжает', () => {
  for (const q of ['/x?refresh_id=LEAKME', '/x?session=LEAKME', '/x?private_token=LEAKME', '/x?client_secret=LEAKME']) {
    const raw = validBundle();
    raw.net = [{ url: q, headers: {} }];
    assert.ok(!JSON.stringify(sanitizeBundle(raw).bundle).includes('LEAKME'), q);
  }
});

// --- Fix round (ревью, S3): app.route и errors[].source — тоже URL-образные
// поля (route.fullPath / event.filename) и раньше проходили в бандл без
// redactUrl. ---

test('редактирует секрет в app.route', () => {
  const raw = validBundle();
  raw.app = { build: 'dev', route: '/admin/1?token=LEAKME', isDemo: false };
  const res = sanitizeBundle(raw);
  assert.equal(res.ok, true);
  assert.ok(!res.bundle.app.route.includes('LEAKME'), res.bundle.app.route);
  assert.ok(res.bundle.app.route.includes('/admin/1'), res.bundle.app.route);
});

test('редактирует секрет в errors[].source', () => {
  const raw = validBundle();
  raw.errors = [{ kind: 'onerror', message: 'boom', source: 'https://app.test/chunk.js?session=LEAKME' }];
  const res = sanitizeBundle(raw);
  assert.equal(res.ok, true);
  assert.ok(!res.bundle.errors[0].source.includes('LEAKME'), res.bundle.errors[0].source);
});

// Re-review fix: source должен вести себя как stack — отсутствующее поле
// остаётся undefined, а не превращается редакцией в '' (редактирование не
// имеет права ДОБАВЛЯТЬ поля, которых не было во входном бандле).
test('errors[].source отсутствует — остаётся undefined, не становится пустой строкой', () => {
  const raw = validBundle();
  raw.errors = [{ kind: 'onerror', message: 'boom' }];
  const res = sanitizeBundle(raw);
  assert.equal(res.ok, true);
  assert.equal(res.bundle.errors[0].source, undefined);
  assert.ok(!('source' in JSON.parse(JSON.stringify(res.bundle.errors[0]))), 'source не должен появляться в сериализованном виде');
});

test('app отсутствует или не объект — санитизация не падает', () => {
  for (const badApp of [undefined, null, 'x', ['a']]) {
    const raw = validBundle();
    raw.app = badApp;
    const res = sanitizeBundle(raw);
    assert.equal(res.ok, true, JSON.stringify(badApp));
  }
});
