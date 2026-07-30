import test from 'node:test'
import assert from 'node:assert/strict'
import { redactHeaders, redactUrl, redactText, REDACTED } from './redact.ts'

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

test('redactText: URL внутри текста ошибки — секрет скрыт, путь цел', () => {
  const out = redactText('POST /api/reports?token=SECRET&azsId=548 failed with 502')
  assert.ok(!out.includes('SECRET'), out)
  assert.ok(out.includes('azsId=548'), out)
  assert.ok(out.includes('/api/reports'), out)
})

test('redactText: Bearer в стеке скрыт', () => {
  const out = redactText('at fetch (Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc)')
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), out)
})

test('redactText: двоеточие и кавычки как разделитель тоже ловятся', () => {
  assert.ok(!redactText('{"access_token":"zzz"}').includes('zzz'))
})

test('redactText: покрыты все текстовые ключи', () => {
  for (const k of ['token', 'access_token', 'refresh_token', 'auth', 'sessid', 'api_key', 'apikey']) {
    assert.ok(!redactText(`${k}=LEAK`).includes('LEAK'), k)
  }
})

test('redactText: регистр ключа не важен', () => {
  assert.ok(!redactText('TOKEN=LEAK').includes('LEAK'))
})

test('redactText: безобидный текст не искажается', () => {
  const msg = 'Не удалось загрузить фото: сеть недоступна (azsId=548, попытка 2)'
  assert.equal(redactText(msg), msg)
})

test('redactText: слово token в прозе не ломает текст', () => {
  assert.equal(redactText('refresh token истёк'), 'refresh token истёк')
})

test('redactText: пустой вход', () => {
  assert.equal(redactText(''), '')
})

test('redactText: закрыты утечки, найденные ре-ревью', () => {
  const cases = [
    'client_secret=LEAK', 'client-secret=LEAK', 'password=LEAK', 'passwd=LEAK',
    'auth_id=LEAK', 'authid=LEAK', 'api-key=LEAK', 'x-api-key: LEAK',
    'apikey=LEAK', 'api_key=LEAK', 'refresh-token=LEAK', 'refreshtoken=LEAK',
    'access-token=LEAK', 'session-id=LEAK', 'sessid=LEAK', 'secret=LEAK',
    'pwd=LEAK', 'id_token=LEAK', 'authorization=LEAK'
  ]
  for (const c of cases) {
    assert.ok(!redactText(c).includes('LEAK'), `утечка: ${c} -> ${redactText(c)}`)
  }
})

test('redactText: значение с запятой маскируется целиком', () => {
  const out = redactText('token=abc123,def456')
  assert.ok(!out.includes('abc123'), out)
  assert.ok(!out.includes('def456'), out)
})

test('redactText: несколько секретов в одной строке', () => {
  const out = redactText('token=AAA sessid=BBB client_secret=CCC')
  for (const s of ['AAA', 'BBB', 'CCC']) assert.ok(!out.includes(s), out)
})

test('redactText: короткий Bearer тоже ловится', () => {
  assert.ok(!redactText('Bearer abcd').includes('abcd'))
})

test('redactText: проза не искажается', () => {
  for (const msg of [
    'Не удалось загрузить фото: сеть недоступна (azsId=548, попытка 2)',
    'refresh token истёк',
    'Ошибка авторизации'
  ]) assert.equal(redactText(msg), msg)
})

test('redactText: Authorization + Bearer вместе не оставляют токен', () => {
  for (const c of [
    'at fetch (Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh)',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh',
    'headers: {authorization: Bearer SUPERSECRETJWT}',
    'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh',
    'basic YWRtaW46cGFzc3dvcmQ='
  ]) {
    const out = redactText(c)
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), `утечка: ${c} -> ${out}`)
    assert.ok(!out.includes('SUPERSECRETJWT'), `утечка: ${c} -> ${out}`)
    assert.ok(!out.includes('YWRtaW46cGFzc3dvcmQ'), `утечка: ${c} -> ${out}`)
  }
})
