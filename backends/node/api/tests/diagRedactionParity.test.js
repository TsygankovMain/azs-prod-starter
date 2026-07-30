import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactText as serverRedactText,
  redactUrl as serverRedactUrl,
  redactHeaders as serverRedactHeaders
} from '../src/diag/sanitizeBundle.js';

// Real client imports from frontend
import {
  redactText as clientRedactText,
  redactUrl as clientRedactUrl,
  redactHeaders as clientRedactHeaders
} from '../../../../frontend/app/utils/diag/redact.ts';

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
