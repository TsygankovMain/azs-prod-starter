import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWebhookContext, isWebhookContext } from '../src/auth/webhookContext.js';

test('buildWebhookContext parses a standard inbound webhook URL', () => {
  const ctx = buildWebhookContext('https://nfr-mainsoft.bitrix24.ru/rest/498/abc123def456/');
  assert.equal(ctx.isWebhook, true);
  assert.equal(ctx.key, 'webhook');
  assert.equal(ctx.endpoint, 'https://nfr-mainsoft.bitrix24.ru/rest/498/abc123def456');
  assert.equal(ctx.domain, 'nfr-mainsoft.bitrix24.ru');
  assert.equal(ctx.userId, 498);
});

test('buildWebhookContext trims trailing slash and keeps base for /<method>.json append', () => {
  const ctx = buildWebhookContext('https://p.bitrix24.ru/rest/1/code/');
  // client will append `/app.info.json` → must not double-slash
  assert.equal(`${ctx.endpoint}/app.info.json`, 'https://p.bitrix24.ru/rest/1/code/app.info.json');
});

test('buildWebhookContext returns null for empty/invalid input', () => {
  assert.equal(buildWebhookContext(''), null);
  assert.equal(buildWebhookContext(null), null);
  assert.equal(buildWebhookContext('not-a-url'), null);
  assert.equal(buildWebhookContext('https://p.bitrix24.ru/'), null); // no /rest/uid/code
  assert.equal(buildWebhookContext('https://p.bitrix24.ru/rest/'), null);
});

test('isWebhookContext detects webhook contexts', () => {
  assert.equal(isWebhookContext(buildWebhookContext('https://p.bitrix24.ru/rest/1/code/')), true);
  assert.equal(isWebhookContext({ authId: 'x' }), false);
  assert.equal(isWebhookContext(null), false);
  assert.equal(isWebhookContext({}), false);
});
