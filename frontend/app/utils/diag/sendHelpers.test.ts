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
  parsePendingJson,
  shouldRetrySend,
  extractHttpStatus,
  extractServerErrorCode,
  nextPendingQueue,
  shouldFlushPending
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

// ── shouldRetrySend (Fix round 1) ────────────────────────────────────────

test('shouldRetrySend: сетевой сбой без статуса повторяем', () => {
  assert.equal(shouldRetrySend(null), true)
})

test('shouldRetrySend: 4xx не повторяем — сервер не примет никогда', () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    assert.equal(shouldRetrySend(status), false, `status ${status}`)
  }
})

test('shouldRetrySend: 5xx повторяем — бэкенд может подняться', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(shouldRetrySend(status), true, `status ${status}`)
  }
})

test('shouldRetrySend: успешные статусы сюда не попадают, но не ломают правило', () => {
  assert.equal(shouldRetrySend(200), true)
})

test('shouldRetrySend: граница 399 — ещё не 4xx, повторяем', () => {
  assert.equal(shouldRetrySend(399), true)
})

test('shouldRetrySend: граница 400 — уже 4xx, не повторяем', () => {
  assert.equal(shouldRetrySend(400), false)
})

test('shouldRetrySend: граница 499 — ещё 4xx, не повторяем', () => {
  assert.equal(shouldRetrySend(499), false)
})

test('shouldRetrySend: граница 500 — уже не 4xx, повторяем', () => {
  assert.equal(shouldRetrySend(500), true)
})

// ── extractHttpStatus ─────────────────────────────────────────────────────

test('extractHttpStatus: undefined/null — null', () => {
  assert.equal(extractHttpStatus(undefined), null)
  assert.equal(extractHttpStatus(null), null)
})

test('extractHttpStatus: обычная Error без сетевых полей — null (как сетевой сбой)', () => {
  assert.equal(extractHttpStatus(new Error('network fail')), null)
})

test('extractHttpStatus: пустой объект — null', () => {
  assert.equal(extractHttpStatus({}), null)
})

test('extractHttpStatus: statusCode', () => {
  assert.equal(extractHttpStatus({ statusCode: 400 }), 400)
})

test('extractHttpStatus: response.status, когда нет statusCode', () => {
  assert.equal(extractHttpStatus({ response: { status: 404 } }), 404)
})

test('extractHttpStatus: status, когда нет ни statusCode, ни response', () => {
  assert.equal(extractHttpStatus({ status: 500 }), 500)
})

test('extractHttpStatus: statusCode важнее response.status и status', () => {
  assert.equal(extractHttpStatus({ statusCode: 400, response: { status: 500 }, status: 200 }), 400)
})

test('extractHttpStatus: response.status важнее голого status', () => {
  assert.equal(extractHttpStatus({ response: { status: 404 }, status: 200 }), 404)
})

test('extractHttpStatus: нечисловое значение не бросает — null', () => {
  assert.equal(extractHttpStatus({ statusCode: 'oops' }), null)
})

// ── extractServerErrorCode ────────────────────────────────────────────────

test('extractServerErrorCode: нет данных — null', () => {
  assert.equal(extractServerErrorCode(undefined), null)
  assert.equal(extractServerErrorCode({}), null)
})

test('extractServerErrorCode: берёт data.error (форма ответа diagRoutes.js)', () => {
  assert.equal(extractServerErrorCode({ data: { error: 'diag_bundle_unprocessable' } }), 'diag_bundle_unprocessable')
})

test('extractServerErrorCode: data.errorCode важнее data.error', () => {
  assert.equal(
    extractServerErrorCode({ data: { errorCode: 'DIAG_TOO_BIG', error: 'diag_bundle_unprocessable' } }),
    'DIAG_TOO_BIG'
  )
})

test('extractServerErrorCode: нестроковое значение — null', () => {
  assert.equal(extractServerErrorCode({ data: { error: 123 } }), null)
})

test('extractServerErrorCode: пустая строка — null', () => {
  assert.equal(extractServerErrorCode({ data: { error: '' } }), null)
})

// ── nextPendingQueue ──────────────────────────────────────────────────────

test('nextPendingQueue: пустая очередь остаётся пустой', () => {
  assert.deepEqual(nextPendingQueue([], []), [])
})

test('nextPendingQueue: успешные уходят из очереди', () => {
  assert.deepEqual(nextPendingQueue(['a', 'b'], ['ok', 'ok']), [])
})

test('nextPendingQueue: сетевой сбой (null) остаётся', () => {
  assert.deepEqual(nextPendingQueue(['a'], [null]), ['a'])
})

test('nextPendingQueue: 5xx остаётся', () => {
  assert.deepEqual(nextPendingQueue(['a'], [503]), ['a'])
})

test('nextPendingQueue: 4xx выбрасывается из очереди', () => {
  assert.deepEqual(nextPendingQueue(['a'], [400]), [])
})

test('nextPendingQueue: смешанная очередь — порядок сохраняется, снимается только 4xx', () => {
  const queue = ['ok-item', 'retry-network', 'drop-400', 'retry-5xx']
  const outcomes: Array<'ok' | number | null> = ['ok', null, 400, 500]
  assert.deepEqual(nextPendingQueue(queue, outcomes), ['retry-network', 'retry-5xx'])
})

test('nextPendingQueue: outcome отсутствует (короче queue) — трактуется как «повторить»', () => {
  assert.deepEqual(nextPendingQueue(['a', 'b'], ['ok']), ['b'])
})

// ── shouldFlushPending (re-review fix: BLOCKING 3 regression) ─────────────
//
// 00.diag.client.ts изначально планировал flushPending() через
// requestIdleCallback/setTimeout(0) — задолго до того, как apiStore.tokenJWT
// вообще появляется. Без токена запрос гарантированно получает 401,
// shouldRetrySend(401) === false, и flushPending() стирал всю очередь как
// «отклонена окончательно» — путал «мы сами не приложили токен» с «сервер
// не хочет этот бандл». shouldFlushPending() — это решение «пробовать ли
// вообще», проверяемое ДО единого обращения к сети.

test('shouldFlushPending: нет токена, очередь пуста — не запускаем', () => {
  assert.equal(shouldFlushPending(false, 0), false)
})

test('shouldFlushPending: токен есть, очередь пуста — нечего дожимать', () => {
  assert.equal(shouldFlushPending(true, 0), false)
})

test('shouldFlushPending: токен есть, очередь не пуста — запускаем', () => {
  assert.equal(shouldFlushPending(true, 3), true)
})

test('shouldFlushPending: нет токена, но очередь НЕ пуста — всё равно не запускаем (иначе 401 из-за отсутствия токена был бы принят за окончательный отказ сервера и стёр бы очередь)', () => {
  assert.equal(shouldFlushPending(false, 3), false)
})
