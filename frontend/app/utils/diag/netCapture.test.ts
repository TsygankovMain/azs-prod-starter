import test from 'node:test'
import assert from 'node:assert/strict'
import { isOwnOriginRequestUrl, resolveRequestMethod, resolveRequestUrl } from './netCapture.ts'

const ORIGIN = 'https://app.test'

test('resolveRequestUrl: строка возвращается как есть', () => {
  assert.equal(resolveRequestUrl('/api/x'), '/api/x')
})

test('resolveRequestUrl: URL приводится к строке', () => {
  assert.equal(resolveRequestUrl(new URL('https://app.test/api/x')), 'https://app.test/api/x')
})

test('resolveRequestUrl: у Request берётся .url', () => {
  const req = new Request('https://app.test/api/x', { method: 'POST' })
  assert.equal(resolveRequestUrl(req), 'https://app.test/api/x')
})

test('resolveRequestMethod: берёт init.method и приводит к верхнему регистру', () => {
  assert.equal(resolveRequestMethod('/api/x', { method: 'post' }), 'POST')
})

test('resolveRequestMethod: без init.method и без Request — GET по умолчанию', () => {
  assert.equal(resolveRequestMethod('/api/x'), 'GET')
  assert.equal(resolveRequestMethod(new URL('https://app.test/api/x')), 'GET')
})

test('resolveRequestMethod: метод берётся из Request, когда init пуст', () => {
  const req = new Request('https://app.test/api/x', { method: 'PUT' })
  assert.equal(resolveRequestMethod(req), 'PUT')
})

test('resolveRequestMethod: init.method важнее метода из Request', () => {
  const req = new Request('https://app.test/api/x', { method: 'PUT' })
  assert.equal(resolveRequestMethod(req, { method: 'delete' }), 'DELETE')
})

test('isOwnOriginRequestUrl: относительный путь — наш origin', () => {
  assert.equal(isOwnOriginRequestUrl('/api/diag/ping', ORIGIN), true)
})

test('isOwnOriginRequestUrl: абсолютный URL нашего origin', () => {
  assert.equal(isOwnOriginRequestUrl('https://app.test/api/x', ORIGIN), true)
})

test('isOwnOriginRequestUrl: чужой origin отклонён', () => {
  assert.equal(isOwnOriginRequestUrl('https://other.test/x', ORIGIN), false)
})

test('isOwnOriginRequestUrl: protocol-relative URL на чужой хост не считается своим', () => {
  // Регрессия: url.startsWith('/') было бы true для '//evil.example/...'.
  assert.equal(isOwnOriginRequestUrl('//evil.example/steal', ORIGIN), false)
})

test('isOwnOriginRequestUrl: суффиксный спуфинг origin отклонён', () => {
  // Регрессия: url.startsWith(appOrigin) было бы true — origin просто длиннее.
  assert.equal(isOwnOriginRequestUrl('https://app.test.evil.example/x', ORIGIN), false)
})

test('isOwnOriginRequestUrl: некорректный URL не бросает и считается чужим', () => {
  assert.equal(isOwnOriginRequestUrl('http://', ORIGIN), false)
})
