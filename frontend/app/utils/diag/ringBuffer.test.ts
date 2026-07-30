import test from 'node:test'
import assert from 'node:assert/strict'
import { createRingBuffer } from './ringBuffer.ts'

test('держит вместимость и вытесняет самое старое', () => {
  const b = createRingBuffer<number>(3)
  for (const n of [1, 2, 3, 4, 5]) b.push(n)
  assert.deepEqual(b.toArray(), [3, 4, 5])
  assert.equal(b.size, 3)
})

test('считает вытесненные записи', () => {
  const b = createRingBuffer<number>(2)
  assert.equal(b.dropped, 0)
  b.push(1); b.push(2); b.push(3)
  assert.equal(b.dropped, 1)
})

test('toArray возвращает копию, а не внутренний массив', () => {
  const b = createRingBuffer<number>(2)
  b.push(1)
  b.toArray().push(99)
  assert.deepEqual(b.toArray(), [1])
})

test('некорректная вместимость бросает RangeError', () => {
  assert.throws(() => createRingBuffer<number>(0), RangeError)
  assert.throws(() => createRingBuffer<number>(-1), RangeError)
  assert.throws(() => createRingBuffer<number>(1.5), RangeError)
})
