import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUploadSuccessEntry,
  buildUploadErrorEntry,
  extractUploadHttpStatus,
  buildQueueSlotSnapshot,
  buildQueueSnapshot
} from './uploadDiag.ts'
import type { UploadAttempt } from './uploadDiag.ts'

const attempt = (overrides: Partial<UploadAttempt> = {}): UploadAttempt => ({
  photoCode: 'p1',
  fileSize: 12345,
  fileType: 'image/jpeg',
  startedAt: '2026-07-30T09:00:00.000Z',
  startedAtMs: 1000,
  attempt: 7,
  ...overrides
})

// ── buildUploadSuccessEntry ─────────────────────────────────────────────────

test('buildUploadSuccessEntry: переносит фиксированные поля успеха', () => {
  const entry = buildUploadSuccessEntry(attempt(), 1500)
  assert.equal(entry.outcome, 'ok')
  assert.equal(entry.httpStatus, 200)
  assert.equal(entry.errorCode, null)
  assert.equal(entry.retryable, null)
  assert.equal(entry.message, '')
})

test('buildUploadSuccessEntry: exifTakenAt всегда null (EXIF — бэкенд, этап 1)', () => {
  assert.equal(buildUploadSuccessEntry(attempt(), 1500).exifTakenAt, null)
})

test('buildUploadSuccessEntry: переносит photoCode/fileSize/fileType/startedAt/attempt как есть', () => {
  const entry = buildUploadSuccessEntry(attempt({ photoCode: 'front', fileSize: 999, fileType: 'image/png', attempt: 3 }), 1500)
  assert.equal(entry.photoCode, 'front')
  assert.equal(entry.fileSize, 999)
  assert.equal(entry.fileType, 'image/png')
  assert.equal(entry.startedAt, '2026-07-30T09:00:00.000Z')
  assert.equal(entry.attempt, 3)
})

test('buildUploadSuccessEntry: durationMs — разница startedAtMs/nowMs, округлённая', () => {
  const entry = buildUploadSuccessEntry(attempt({ startedAtMs: 1000.2 }), 1500.9)
  assert.equal(entry.durationMs, Math.round(1500.9 - 1000.2))
})

test('buildUploadSuccessEntry: durationMs=0, когда nowMs совпадает со startedAtMs', () => {
  assert.equal(buildUploadSuccessEntry(attempt({ startedAtMs: 42 }), 42).durationMs, 0)
})

// ── buildUploadErrorEntry ────────────────────────────────────────────────────

const failure = () => ({
  httpStatus: 502,
  errorCode: 'BX_UPLOAD_FAILED',
  retryable: true,
  message: 'Не удалось загрузить фото'
})

test('buildUploadErrorEntry: переносит поля из failure', () => {
  const entry = buildUploadErrorEntry(attempt(), 1500, failure())
  assert.equal(entry.outcome, 'error')
  assert.equal(entry.httpStatus, 502)
  assert.equal(entry.errorCode, 'BX_UPLOAD_FAILED')
  assert.equal(entry.retryable, true)
  assert.equal(entry.message, 'Не удалось загрузить фото')
})

test('buildUploadErrorEntry: exifTakenAt всегда null', () => {
  assert.equal(buildUploadErrorEntry(attempt(), 1500, failure()).exifTakenAt, null)
})

test('buildUploadErrorEntry: httpStatus/errorCode/retryable могут быть null (сетевой сбой без ответа)', () => {
  const entry = buildUploadErrorEntry(attempt(), 1500, { httpStatus: null, errorCode: null, retryable: null, message: 'network error' })
  assert.equal(entry.httpStatus, null)
  assert.equal(entry.errorCode, null)
  assert.equal(entry.retryable, null)
  assert.equal(entry.message, 'network error')
})

test('buildUploadErrorEntry: durationMs — разница startedAtMs/nowMs, округлённая', () => {
  const entry = buildUploadErrorEntry(attempt({ startedAtMs: 2000 }), 2734, failure())
  assert.equal(entry.durationMs, 734)
})

test('buildUploadErrorEntry: photoCode/attempt переносятся как есть (для сопоставления со слотом)', () => {
  const entry = buildUploadErrorEntry(attempt({ photoCode: 'back', attempt: 9 }), 1500, failure())
  assert.equal(entry.photoCode, 'back')
  assert.equal(entry.attempt, 9)
})

// ── extractUploadHttpStatus ──────────────────────────────────────────────────

test('extractUploadHttpStatus: undefined/null — null', () => {
  assert.equal(extractUploadHttpStatus(undefined), null)
  assert.equal(extractUploadHttpStatus(null), null)
})

test('extractUploadHttpStatus: обычная Error без сетевых полей — null', () => {
  assert.equal(extractUploadHttpStatus(new Error('boom')), null)
})

test('extractUploadHttpStatus: пустой объект — null', () => {
  assert.equal(extractUploadHttpStatus({}), null)
})

test('extractUploadHttpStatus: statusCode', () => {
  assert.equal(extractUploadHttpStatus({ statusCode: 403 }), 403)
})

test('extractUploadHttpStatus: status, когда нет statusCode', () => {
  assert.equal(extractUploadHttpStatus({ status: 500 }), 500)
})

test('extractUploadHttpStatus: statusCode важнее status', () => {
  assert.equal(extractUploadHttpStatus({ statusCode: 403, status: 500 }), 403)
})

test('extractUploadHttpStatus: нечисловое значение не бросает — null', () => {
  assert.equal(extractUploadHttpStatus({ statusCode: 'oops' }), null)
})

test('extractUploadHttpStatus: statusCode=0 — унаследованная особенность формулы: 0 ложно для ||, поэтому берётся status', () => {
  // Как и в brief (Task 9, Step 2): Number(a || b || 0) || null считает 0 отсутствием
  // значения на каждом шаге цепочки — это перенос формулы как есть, а не её починка.
  assert.equal(extractUploadHttpStatus({ statusCode: 0, status: 404 }), 404)
})

test('extractUploadHttpStatus: statusCode=0 и status отсутствует — null', () => {
  assert.equal(extractUploadHttpStatus({ statusCode: 0 }), null)
})

// ── buildQueueSlotSnapshot ────────────────────────────────────────────────────

test('buildQueueSlotSnapshot: file присутствует — fileSize/fileType из file', () => {
  const snap = buildQueueSlotSnapshot({
    key: 'p1', confirmed: true, uploadState: 'error', uploaded: false,
    file: { size: 4096, type: 'image/webp' }, error: 'timeout'
  })
  assert.deepEqual(snap, {
    key: 'p1', confirmed: true, uploadState: 'error', uploaded: false,
    fileSize: 4096, fileType: 'image/webp', error: 'timeout'
  })
})

test('buildQueueSlotSnapshot: file=null — fileSize 0, fileType пустая строка', () => {
  const snap = buildQueueSlotSnapshot({
    key: 'p2', confirmed: false, uploadState: 'idle', uploaded: false, file: null, error: ''
  })
  assert.equal(snap.fileSize, 0)
  assert.equal(snap.fileType, '')
})

// ── buildQueueSnapshot ────────────────────────────────────────────────────────

test('buildQueueSnapshot: activeCount/maxConcurrency переносятся, sessionId -> workerSessionId', () => {
  const snapshot = buildQueueSnapshot({ activeCount: 2, maxConcurrency: 2, sessionId: 5 }, [])
  assert.equal(snapshot.activeCount, 2)
  assert.equal(snapshot.maxConcurrency, 2)
  assert.equal(snapshot.workerSessionId, 5)
})

test('buildQueueSnapshot: пустой список слотов', () => {
  assert.deepEqual(buildQueueSnapshot({ activeCount: 0, maxConcurrency: 2, sessionId: 1 }, []).slots, [])
})

test('buildQueueSnapshot: список слотов собирается через buildQueueSlotSnapshot (в т.ч. смешанный file/null)', () => {
  const snapshot = buildQueueSnapshot({ activeCount: 1, maxConcurrency: 2, sessionId: 1 }, [
    { key: 'a', confirmed: true, uploadState: 'uploaded', uploaded: true, file: { size: 10, type: 'image/jpeg' }, error: '' },
    { key: 'b', confirmed: true, uploadState: 'error', uploaded: false, file: null, error: 'boom' }
  ])
  assert.equal(snapshot.slots.length, 2)
  assert.equal(snapshot.slots[0]!.fileSize, 10)
  assert.equal(snapshot.slots[1]!.fileSize, 0)
  assert.equal(snapshot.slots[1]!.error, 'boom')
})
