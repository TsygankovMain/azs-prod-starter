import type { DiagTrigger } from './types.ts'

/**
 * Чистые хелперы для composables/diag/useDiagSender.ts.
 *
 * Вынесены в отдельный модуль по прецеденту netCapture.ts (Task 7): сам
 * composable дёргает window/fetch/crypto/performance и не тестируется
 * напрямую под node --test, а вот арифметика пробы, разбор localStorage
 * и сборка заголовка авторизации от браузерных глобалей не зависят —
 * значит их можно и нужно проверить тестами.
 */

/**
 * Размер пробы зависит от триггера.
 *
 * Автоотправка срабатывает в момент реального сбоя, когда канал уже занят
 * ретраями загрузки. 300 КБ на канале 40 кбит/с — это ещё ~60 с отдачи, то есть
 * диагностика ухудшала бы аварию, которую измеряет. 32 КБ дают ~5 с и всё так же
 * изолируют канал от Диска Битрикса.
 *
 * Кнопку жмут осознанно, обычно когда работа уже встала, — там полная проба
 * даёт более точный замер и мешать нечему.
 *
 * Два значения обязаны остаться разными — это и есть весь смысл разделения
 * по триггеру, поэтому ниже это отдельно проверяется тестом.
 */
export const ECHO_BYTES_BY_TRIGGER: Record<DiagTrigger, number> = {
  button: 307_200,
  auto_upload_error: 32_768
}

/** Сколько байт гонять в echo-пробе для данного триггера. */
export function echoBytesForTrigger(trigger: DiagTrigger): number {
  return ECHO_BYTES_BY_TRIGGER[trigger]
}

/**
 * Пропускная способность в кбит/с по замеру эхо-пробы.
 * echoBytes*8 — это биты; деление на elapsedMs (мс) численно даёт кбит/с,
 * потому что оба множителя 1000 (мс→с и бит→кбит) взаимно сокращаются.
 * Проверку по границе (elapsedMs=0) сюда намеренно не добавляем: вызывающий
 * код уже гарантирует elapsedMs >= 1 через Math.max(1, ...) до вызова —
 * поведение при 0 здесь просто зафиксировано тестом, а не «исправлено».
 */
export function computeEchoKbps(echoBytes: number, elapsedMs: number): number {
  return Math.round((echoBytes * 8) / elapsedMs)
}

/**
 * Медиана серии пинг-замеров (мс). Для чётной длины берётся верхний из двух
 * средних элементов (Math.floor(n/2)), а не их среднее, — упрощение, унаследованное
 * от брифа как есть. При PING_ATTEMPTS=3 длина обычно нечётная (или меньше
 * из-за потерь), так что для типичного случая это настоящая медиана.
 */
export function pingMedianMs(samplesMs: number[]): number | null {
  if (samplesMs.length === 0) return null
  const sorted = samplesMs.slice().sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length / 2)]!)
}

/** Доля потерянных пингов в процентах от общего числа попыток. */
export function pingLossPercent(lost: number, attempts: number): number {
  return Math.round((lost / attempts) * 100)
}

/** Заголовок Authorization добавляется, только когда есть JWT. */
export function buildAuthHeaders(jwt: string | null | undefined): Record<string, string> {
  return jwt ? { Authorization: `Bearer ${jwt}` } : {}
}

/**
 * Базовый URL API без ровно одного хвостового слэша (как в брифе:
 * String(x).replace(/\/$/, '') снимает один хвостовой слэш, не все).
 * Пустое/нечисловое значение конфига → пустая строка, а не 'undefined'/'null'.
 */
export function resolveApiBase(rawApiUrl: unknown): string {
  return String(rawApiUrl || '').replace(/\/$/, '')
}

/**
 * Разбор сохранённой в localStorage очереди ретрая. Битый JSON, не-массив
 * или отсутствующее значение — всегда пустой массив, никогда не бросает:
 * это то же поведение, что и в брифовом readPending(), только без самого
 * обращения к localStorage (его не воспроизвести под node --test).
 */
export function parsePendingJson(raw: string | null): unknown[] {
  try {
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}
