import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ECHO_BYTES_BY_TRIGGER,
  echoBytesForTrigger,
  computeEchoKbps,
  pingMedianMs,
  pingLossPercent,
  buildAuthHeaders,
  resolveApiBase,
  parsePendingJson
} from './sendHelpers.ts'

// ── echoBytesForTrigger ──────────────────────────────────────────────────
// Это самое важное поведение файла: авто-триггер обязан оставаться намного
// меньше кнопочного, иначе диагностика на дохлом канале станет второй аварией.

test('кнопка: 300 КБ (307200 байт)', () => {
  assert.equal(echoBytesForTrigger('button'), 307_200)
})

test('автоотправка при сбое: 32 КБ (32768 байт)', () => {
  assert.equal(echoBytesForTrigger('auto_upload_error'), 32_768)
})

test('размеры для кнопки и автоотправки различны', () => {
  assert.notEqual(ECHO_BYTES_BY_TRIGGER.button, ECHO_BYTES_BY_TRIGGER.auto_upload_error)
})

test('автоотправка заметно меньше кнопки (изоляция дохлого канала)', () => {
  assert.ok(ECHO_BYTES_BY_TRIGGER.auto_upload_error < ECHO_BYTES_BY_TRIGGER.button)
})

test('карта размеров содержит ровно оба известных триггера', () => {
  assert.deepEqual(Object.keys(ECHO_BYTES_BY_TRIGGER).sort(), ['auto_upload_error', 'button'])
})

// ── computeEchoKbps ───────────────────────────────────────────────────────

test('computeEchoKbps: 1000 байт за 8 мс — 1000 кбит/с', () => {
  assert.equal(computeEchoKbps(1000, 8), 1000)
})

test('computeEchoKbps: округление до целого', () => {
  // 1 байт = 8 бит; 8 бит / 3 мс = 2.666... -> округляется до 3
  assert.equal(computeEchoKbps(1, 3), 3)
})

test('computeEchoKbps: пример из обоснования — 300 КБ за 61440 мс это ~40 кбит/с', () => {
  assert.equal(computeEchoKbps(307_200, 61_440), 40)
})

test('computeEchoKbps: elapsedMs=0 не заворачивается в защиту здесь — это забота вызывающего кода', () => {
  assert.equal(computeEchoKbps(100, 0), Infinity)
})

// ── pingMedianMs ──────────────────────────────────────────────────────────

test('pingMedianMs: пустая серия — null', () => {
  assert.equal(pingMedianMs([]), null)
})

test('pingMedianMs: один замер — он и есть медиана', () => {
  assert.equal(pingMedianMs([42]), 42)
})

test('pingMedianMs: нечётная серия — настоящая медиана после сортировки', () => {
  assert.equal(pingMedianMs([30, 10, 20]), 20)
})

test('pingMedianMs: чётная серия — берётся верхний из двух средних', () => {
  assert.equal(pingMedianMs([10, 20, 30, 40]), 30)
})

test('pingMedianMs: результат округляется до целого', () => {
  assert.equal(pingMedianMs([10.2, 10.9, 11.6]), 11)
})

// ── pingLossPercent ───────────────────────────────────────────────────────

test('pingLossPercent: нет потерь', () => {
  assert.equal(pingLossPercent(0, 3), 0)
})

test('pingLossPercent: все потеряны', () => {
  assert.equal(pingLossPercent(3, 3), 100)
})

test('pingLossPercent: 1 из 3 — округление до 33', () => {
  assert.equal(pingLossPercent(1, 3), 33)
})

// ── buildAuthHeaders ──────────────────────────────────────────────────────

test('buildAuthHeaders: есть JWT — заголовок Bearer', () => {
  assert.deepEqual(buildAuthHeaders('abc123'), { Authorization: 'Bearer abc123' })
})

test('buildAuthHeaders: пустая строка — пустой объект', () => {
  assert.deepEqual(buildAuthHeaders(''), {})
})

test('buildAuthHeaders: null — пустой объект', () => {
  assert.deepEqual(buildAuthHeaders(null), {})
})

test('buildAuthHeaders: undefined — пустой объект', () => {
  assert.deepEqual(buildAuthHeaders(undefined), {})
})

// ── resolveApiBase ────────────────────────────────────────────────────────

test('resolveApiBase: снимает один хвостовой слэш', () => {
  assert.equal(resolveApiBase('https://x.test/'), 'https://x.test')
})

test('resolveApiBase: без хвостового слэша — не меняется', () => {
  assert.equal(resolveApiBase('https://x.test'), 'https://x.test')
})

test('resolveApiBase: снимается ровно один слэш, не все подряд', () => {
  assert.equal(resolveApiBase('https://x.test//'), 'https://x.test/')
})

test('resolveApiBase: undefined — пустая строка', () => {
  assert.equal(resolveApiBase(undefined), '')
})

test('resolveApiBase: null — пустая строка', () => {
  assert.equal(resolveApiBase(null), '')
})

// ── parsePendingJson ──────────────────────────────────────────────────────

test('parsePendingJson: null — пустой массив', () => {
  assert.deepEqual(parsePendingJson(null), [])
})

test('parsePendingJson: пустая строка — пустой массив', () => {
  assert.deepEqual(parsePendingJson(''), [])
})

test('parsePendingJson: битый JSON не бросает — пустой массив', () => {
  assert.deepEqual(parsePendingJson('not json{'), [])
})

test('parsePendingJson: валидный JSON, но не массив — пустой массив', () => {
  assert.deepEqual(parsePendingJson('{"a":1}'), [])
})

test('parsePendingJson: валидный массив возвращается как есть', () => {
  assert.deepEqual(parsePendingJson('[1,2,3]'), [1, 2, 3])
})

test('parsePendingJson: пустой JSON-массив', () => {
  assert.deepEqual(parsePendingJson('[]'), [])
})
