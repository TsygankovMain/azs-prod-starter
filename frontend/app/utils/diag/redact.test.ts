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

test('redactHeaders: покрыт весь список секретных заголовков', () => {
  const out = redactHeaders({
    authorization: 'a', cookie: 'b', 'set-cookie': 'c', 'x-api-key': 'd', 'x-keep': 'keep'
  })
  assert.equal(out.authorization, REDACTED)
  assert.equal(out.cookie, REDACTED)
  assert.equal(out['set-cookie'], REDACTED)
  assert.equal(out['x-api-key'], REDACTED)
  assert.equal(out['x-keep'], 'keep')
})

test('redactUrl: покрыт весь список секретных query-ключей', () => {
  assert.equal(
    redactUrl('/x?token=1&access_token=2&auth=3&sessid=4&keep=5'),
    '/x?token=***&access_token=***&auth=***&sessid=***&keep=5'
  )
})

test('redactUrl: секрет во фрагменте скрыт', () => {
  const out = redactUrl('https://app.test/callback#access_token=SECRET')
  assert.ok(!out.includes('SECRET'), out)
  assert.ok(out.includes(`access_token=${REDACTED}`), out)
})

test('redactUrl: секреты и в query, и во фрагменте', () => {
  const out = redactUrl('https://app.test/api?token=abc#access_token=SECRET')
  assert.ok(!out.includes('abc'), out)
  assert.ok(!out.includes('SECRET'), out)
})

test('redactUrl: фрагмент без секретов не переписывается', () => {
  assert.equal(redactUrl('https://app.test/page#section-title'), 'https://app.test/page#section-title')
})

test('redactUrl: относительный URL сохраняет фрагмент', () => {
  assert.equal(redactUrl('/api/x?sessid=q#auth=z'), '/api/x?sessid=***#auth=***')
})

test('redactUrl: повторяющийся ключ в разном регистре не течёт', () => {
  const out = redactUrl('/x?token=a&TOKEN=b&Token=c')
  assert.ok(!/=[abc](&|$)/.test(out), out)
})
