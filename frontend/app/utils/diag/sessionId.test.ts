import test from 'node:test'
import assert from 'node:assert/strict'
import { generateFallbackSessionId, resolveSessionId } from './sessionId.ts'

test('resolveSessionId использует randomUUID, когда он есть и работает', () => {
  const id = resolveSessionId(() => 'uuid-123')
  assert.equal(id, 'uuid-123')
})

test('resolveSessionId переходит на фолбэк, когда randomUUID не передан', () => {
  const id = resolveSessionId(undefined)
  assert.ok(id.startsWith('mem-'), id)
})

test('resolveSessionId переходит на фолбэк, когда randomUUID бросает (вне secure context)', () => {
  const id = resolveSessionId(() => { throw new Error('crypto.randomUUID is not a function') })
  assert.ok(id.startsWith('mem-'), id)
})

test('resolveSessionId переходит на фолбэк, когда randomUUID вернул пустую строку', () => {
  const id = resolveSessionId(() => '')
  assert.ok(id.startsWith('mem-'), id)
})

test('resolveSessionId никогда не бросает, даже если randomUUID бросает нестандартное значение', () => {
  assert.doesNotThrow(() => resolveSessionId(() => { throw 'not an Error instance' }))
})

test('generateFallbackSessionId начинается с mem- и содержит что-то после префикса', () => {
  const id = generateFallbackSessionId(1_700_000_000_000, 0.123456789)
  assert.ok(id.startsWith('mem-'), id)
  assert.ok(id.length > 'mem-'.length, id)
})

test('generateFallbackSessionId детерминирован при одинаковых входах', () => {
  const a = generateFallbackSessionId(1_700_000_000_000, 0.123456789)
  const b = generateFallbackSessionId(1_700_000_000_000, 0.123456789)
  assert.equal(a, b)
})

test('generateFallbackSessionId даёт разные id для разных входов', () => {
  const a = generateFallbackSessionId(1, 0.1)
  const b = generateFallbackSessionId(2, 0.2)
  assert.notEqual(a, b)
})

test('generateFallbackSessionId работает без аргументов (реальные Date.now/Math.random)', () => {
  const id = generateFallbackSessionId()
  assert.ok(id.startsWith('mem-'), id)
})
