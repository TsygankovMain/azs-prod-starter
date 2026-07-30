import type { QueueSlotSnapshot, QueueSnapshot, UploadEntry } from './types.ts'

/**
 * Чистые хелперы для записи исхода загрузки фото (Task 9) — вызываются из
 * runUploadTask в frontend/app/pages/admin/[reportId].client.vue.
 *
 * Вынесены в отдельный модуль по прецеденту netCapture.ts/sendHelpers.ts
 * (Task 7/8): сама страница — Vue SFC, в этом репозитории её не прогнать под
 * node --test (нет jsdom/vue-test-utils/nuxt-test-utils), а сборка
 * UploadEntry/QueueSnapshot из уже готовых значений — обычная арифметика без
 * window/fetch/Vue, и её стоит проверить тестами.
 *
 * exifTakenAt всегда null на этом этапе: EXIF разбирается на бэкенде (см.
 * врезку в task-9-brief.md §3.3 и код PHOTO_EXIF_TOO_OLD в
 * src/reports/errorCodes.js), тащить парсер во фронт ради одного поля — вне
 * рамок минимального патча. Поле остаётся в форме, чтобы её не пришлось
 * менять на следующем этапе.
 */

/** Общие для успеха и ошибки данные об одной попытке загрузки фото. */
export type UploadAttempt = {
  photoCode: string
  fileSize: number
  fileType: string
  startedAt: string
  startedAtMs: number
  attempt: number
}

const durationSince = (startedAtMs: number, nowMs: number): number => Math.round(nowMs - startedAtMs)

/** UploadEntry для успешно завершённой загрузки. */
export function buildUploadSuccessEntry(attemptInfo: UploadAttempt, nowMs: number): UploadEntry {
  return {
    photoCode: attemptInfo.photoCode,
    fileSize: attemptInfo.fileSize,
    fileType: attemptInfo.fileType,
    exifTakenAt: null,
    startedAt: attemptInfo.startedAt,
    durationMs: durationSince(attemptInfo.startedAtMs, nowMs),
    outcome: 'ok',
    httpStatus: 200,
    errorCode: null,
    retryable: null,
    attempt: attemptInfo.attempt,
    message: ''
  }
}

/** Разбор ошибки, специфичный для ветки catch runUploadTask. */
export type UploadFailureDetails = {
  httpStatus: number | null
  errorCode: string | null
  retryable: boolean | null
  message: string
}

/** UploadEntry для неудачной загрузки. */
export function buildUploadErrorEntry(
  attemptInfo: UploadAttempt,
  nowMs: number,
  failure: UploadFailureDetails
): UploadEntry {
  return {
    photoCode: attemptInfo.photoCode,
    fileSize: attemptInfo.fileSize,
    fileType: attemptInfo.fileType,
    exifTakenAt: null,
    startedAt: attemptInfo.startedAt,
    durationMs: durationSince(attemptInfo.startedAtMs, nowMs),
    outcome: 'error',
    httpStatus: failure.httpStatus,
    errorCode: failure.errorCode,
    retryable: failure.retryable,
    attempt: attemptInfo.attempt,
    message: failure.message
  }
}

/**
 * HTTP-статус из ошибки apiStore.uploadReportPhoto. Формула нарочно совпадает
 * с брифом (Task 9, Step 2): statusCode приоритетнее status, 0 трактуется как
 * «нет статуса» (Number(...) || null сворачивает и 0, и NaN в null) — это тот
 * же приём, что и в соседней extractHttpStatus (sendHelpers.ts), но без
 * третьего источника response.status: ошибка загрузки фото в этом файле
 * разбирается только по statusCode/status (см. runUploadTask), добавлять
 * source, которого нет в брифе, — значит менять поведение мимо задания.
 */
export function extractUploadHttpStatus(error: unknown): number | null {
  const e = error as { statusCode?: unknown; status?: unknown } | null | undefined
  return Number(e?.statusCode || e?.status || 0) || null
}

/** «Сырые» поля одного слота очереди — подмножество SlotState со страницы. */
export type RawQueueSlot = {
  key: string
  confirmed: boolean
  uploadState: string
  uploaded: boolean
  file: { size: number; type: string } | null
  error: string
}

/** Один слот очереди в форме, пригодной для бандла. */
export function buildQueueSlotSnapshot(slot: RawQueueSlot): QueueSlotSnapshot {
  return {
    key: slot.key,
    confirmed: slot.confirmed,
    uploadState: slot.uploadState,
    uploaded: slot.uploaded,
    fileSize: slot.file?.size ?? 0,
    fileType: slot.file?.type ?? '',
    error: slot.error
  }
}

/** Подмножество полей uploadWorker, нужное снимку очереди. */
export type RawQueueWorker = { activeCount: number; maxConcurrency: number; sessionId: number }

/** Снимок очереди целиком из состояния воркера и списка слотов страницы. */
export function buildQueueSnapshot(worker: RawQueueWorker, slots: RawQueueSlot[]): QueueSnapshot {
  return {
    activeCount: worker.activeCount,
    maxConcurrency: worker.maxConcurrency,
    workerSessionId: worker.sessionId,
    slots: slots.map(buildQueueSlotSnapshot)
  }
}
