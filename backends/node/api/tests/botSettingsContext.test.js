/**
 * BUG-A8: resolveBotSettingsContext — контекст для чтения настроек в бот-флоу.
 *
 * Суть фикса: app.option.get требует OAuth-контекст приложения (admin).
 * Вебхук получает 403 ACCESS_DENIED. Поэтому при чтении настроек
 * предпочитаем adminContext; вебхук — только фоллбэк.
 *
 * TDD: тест написан ПЕРВЫМ, до создания модуля.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBotSettingsContext } from '../src/notifications/botSettingsContext.js';

test('resolveBotSettingsContext: adminContext непустой + webhookContext непустой → возвращает adminContext', () => {
  const adminContext = { key: 'user|1', domain: 'portal.bitrix24.ru', access_token: 'tok_admin' };
  const webhookContext = { domain: 'portal.bitrix24.ru', webhookUrl: 'https://portal.bitrix24.ru/rest/1/abc/' };

  const result = resolveBotSettingsContext({ adminContext, webhookContext });

  assert.deepStrictEqual(result, adminContext,
    'Должен вернуть adminContext, т.к. только он умеет app.option.get (webhook → 403)'
  );
});

test('resolveBotSettingsContext: adminContext пустой {} + webhookContext непустой → возвращает webhookContext (фоллбэк)', () => {
  const adminContext = {};
  const webhookContext = { domain: 'portal.bitrix24.ru', webhookUrl: 'https://portal.bitrix24.ru/rest/1/abc/' };

  const result = resolveBotSettingsContext({ adminContext, webhookContext });

  assert.deepStrictEqual(result, webhookContext,
    'Нет adminContext → фоллбэк на webhook (composite-стор уйдёт в DB-кэш)'
  );
});

test('resolveBotSettingsContext: оба пустые ({} и undefined) → возвращает {} (composite-стор уйдёт в DB-фоллбэк)', () => {
  const result = resolveBotSettingsContext({ adminContext: {}, webhookContext: undefined });

  assert.deepStrictEqual(result, {},
    'Ни admin, ни webhook → {} (composite-стор читает из DB)'
  );
});

test('resolveBotSettingsContext: adminContext undefined + webhookContext непустой → возвращает webhookContext', () => {
  const webhookContext = { domain: 'portal.bitrix24.ru', webhookUrl: 'https://portal.bitrix24.ru/rest/1/abc/' };

  const result = resolveBotSettingsContext({ adminContext: undefined, webhookContext });

  assert.deepStrictEqual(result, webhookContext);
});

test('resolveBotSettingsContext: adminContext непустой + webhookContext undefined → возвращает adminContext', () => {
  const adminContext = { key: 'user|1', domain: 'portal.bitrix24.ru', access_token: 'tok_admin' };

  const result = resolveBotSettingsContext({ adminContext, webhookContext: undefined });

  assert.deepStrictEqual(result, adminContext);
});
