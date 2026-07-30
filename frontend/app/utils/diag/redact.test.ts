import test from 'node:test'
import assert from 'node:assert/strict'
import { redactHeaders, redactUrl, REDACTED } from './redact.ts'

test('redactHeaders: секретные заголовки скрыты независимо от регистра', () => {
  const out = redactHeaders({ Authorization: 'Bearer x', COOKIE: 'a=1', 'X-Ok': 'keep' })
  assert.equal(out.Authorization, REDACTED)
  assert.equal(out.COOKIE, REDACTED)
  assert.equal(out['X-Ok'], 'keep')
})

test('redactHeaders: пустой вход не падает', () => {
  assert.deepEqual(redactHeaders({}), {})
})

test('redactUrl: секретный query скрыт, остальное сохранено', () => {
  assert.equal(redactUrl('/api/reports?token=abc&azsId=548'), '/api/reports?token=***&azsId=548')
})

test('redactUrl: без секретов строка возвращается как есть', () => {
  assert.equal(redactUrl('/api/reports?azsId=548'), '/api/reports?azsId=548')
})

test('redactUrl: абсолютный URL остаётся абсолютным', () => {
  const out = redactUrl('https://example.test/api?access_token=zzz')
  assert.ok(out.startsWith('https://example.test/api?'))
  assert.ok(!out.includes('zzz'))
})

test('redactUrl: пустая строка', () => {
  assert.equal(redactUrl(''), '')
})
