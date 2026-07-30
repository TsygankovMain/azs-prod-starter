import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText as serverRedactText } from '../src/diag/sanitizeBundle.js';
import { redactText as clientRedactText } from '../../../../frontend/app/utils/diag/redact.ts';

/**
 * Общий корпус. Каждая строка — форма, которая реально встречалась в этом
 * проекте либо была найдена ревью как утечка. Дополняйте корпус, а не
 * ослабляйте проверку.
 */
const CORPUS = [
  // формы, найденные ревью как утечки
  'client_secret=LEAKME', 'client-secret=LEAKME', 'password=LEAKME', 'passwd=LEAKME',
  'auth_id=LEAKME', 'authid=LEAKME', 'REFRESH_ID=LEAKME', 'refresh_id: LEAKME',
  'api-key=LEAKME', 'apikey=LEAKME', 'api_key=LEAKME',
  'private_token=LEAKME', 'bot_token=LEAKME',
  'session=LEAKME', 'session-id=LEAKME', 'sessid=LEAKME', 'Cookie: connect.sid=LEAKME',
  'secret=LEAKME', 'pwd=LEAKME', 'id_token=LEAKME', 'authorization=LEAKME',
  // схемы авторизации
  'at fetch (Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.LEAKME)',
  'headers: {authorization: Bearer LEAKMEJWT}',
  'Bearer eyJhbGciOiJIUzI1NiJ9.LEAKME',
  'basic YWRtaW46LEAKME',
  // частичная маскировка
  'token=abc123,LEAKME', 'token=abc123;LEAKME',
  // реальные поля установки приложения
  'postInstall failed: {AUTH_ID: LEAKME, REFRESH_ID: LEAKME}',
  // JSON-форма
  '{"access_token":"LEAKME","azsId":"548"}',
  // то, что искажать нельзя
  'POST /api/reports?token=SECRETV&azsId=548 failed 502',
  'Не удалось загрузить фото: сеть недоступна (azsId=548, попытка 2)',
  'refresh token истёк',
  'Ошибка авторизации',
  ''
];

test('клиент и сервер чистят текст одинаково', () => {
  const divergent = [];
  for (const input of CORPUS) {
    const client = clientRedactText(input);
    const server = serverRedactText(input);
    if (client !== server) {
      divergent.push(`  вход:   ${JSON.stringify(input)}\n  клиент: ${JSON.stringify(client)}\n  сервер: ${JSON.stringify(server)}`);
    }
  }
  assert.equal(
    divergent.length, 0,
    `Редакция разошлась между слоями (${divergent.length} из ${CORPUS.length}):\n${divergent.join('\n')}`
  );
});

test('ни один слой не пропускает секрет из корпуса', () => {
  const leaks = [];
  for (const input of CORPUS) {
    if (!input.includes('LEAKME')) continue;
    for (const [layer, fn] of [['клиент', clientRedactText], ['сервер', serverRedactText]]) {
      const out = fn(input);
      if (out.includes('LEAKME')) leaks.push(`  ${layer}: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    }
  }
  assert.equal(leaks.length, 0, `Утечки:\n${leaks.join('\n')}`);
});

test('оба слоя сохраняют диагностически полезный контекст', () => {
  for (const fn of [clientRedactText, serverRedactText]) {
    const out = fn('POST /api/reports?token=SECRETV&azsId=548 failed 502');
    assert.ok(!out.includes('SECRETV'), out);
    assert.ok(out.includes('azsId=548'), out);
    assert.ok(out.includes('502'), out);
    assert.ok(out.includes('/api/reports'), out);
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
