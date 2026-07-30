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
