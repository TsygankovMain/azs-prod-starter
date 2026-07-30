import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldSend, trimPendingQueue, SEND_THROTTLE_MS, MAX_PENDING } from './sendPolicy.ts'

test('первая отправка разрешена', () => {
  assert.equal(shouldSend(null, 1_000_000), true)
})

test('повторная отправка внутри окна запрещена', () => {
  assert.equal(shouldSend(1_000_000, 1_000_000 + SEND_THROTTLE_MS - 1), false)
})

test('отправка ровно на границе окна разрешена', () => {
  assert.equal(shouldSend(1_000_000, 1_000_000 + SEND_THROTTLE_MS), true)
})

test('битая метка времени не блокирует отправку', () => {
  assert.equal(shouldSend(Number.NaN, 1_000_000), true)
})

test('очередь ретрая обрезается до предела, свежие сохраняются', () => {
  const queue = [1, 2, 3, 4, 5]
  const out = trimPendingQueue(queue, 3)
  assert.deepEqual(out, [3, 4, 5])
})

test('предел очереди по умолчанию — 3', () => {
  assert.equal(MAX_PENDING, 3)
})
