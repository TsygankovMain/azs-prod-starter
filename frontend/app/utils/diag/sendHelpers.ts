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

// ── Fix round 1: не ретраить то, что сервер не примет никогда ─────────────

/**
 * Стоит ли повторять отправку.
 *
 * 4xx — сервер сказал «такое не приму никогда» (битая версия, неизвестный
 * триггер, превышен потолок). Повтор на каждом открытии приложения стоил бы
 * оператору до 256 КБ на канале, который мы и пытаемся беречь. Сетевой сбой и
 * 5xx повторять стоит: связь или наш бэкенд могут восстановиться.
 */
export function shouldRetrySend(status: number | null): boolean {
  if (status === null) return true
  if (status >= 400 && status < 500) return false
  return true
}

/**
 * Достаёт HTTP-статус из ошибки $fetch. У сетевого сбоя/таймаута нет ни
 * statusCode, ни response.status, ни status — тогда результат null, и
 * shouldRetrySend(null) трактует это как «стоит повторить» (как и для любой
 * ошибки без разбора — так вело себя всё до этого исправления).
 *
 * Три поля вместо одного: в этом репозитории уже есть работающий код,
 * читающий статус из точно такой же ошибки $fetch/ofetch — getFetchStatus
 * в stores/api.ts — и он берёт response?.status ?? status, без statusCode.
 * statusCode — это h3/Nuxt-соглашение (useError()/showError()), не факт,
 * что установлено ofetch-й версией, которая реально стоит в проекте (это
 * нельзя проверить без node_modules). Если довериться только statusCode и
 * ошибиться, вся эта проверка молча превратится в no-op — extractHttpStatus
 * всегда будет отдавать null, и shouldRetrySend всегда будет говорить
 * «повторить», как до фикса. Поэтому здесь совмещены оба источника:
 * первым — statusCode (на случай, если он есть), вторым — response.status
 * (подтверждённое поле из getFetchStatus), третьим — голый status.
 */
export function extractHttpStatus(error: unknown): number | null {
  const e = error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } }
  return Number(e?.statusCode ?? e?.response?.status ?? e?.status) || null
}

/**
 * Достаёт код ошибки из тела ответа бэкенда — только для читаемого лога при
 * отказе от повтора (см. diagRoutes.js: POST /report на 400 всегда отвечает
 * { error: '...' }). errorCode проверяется первым по аналогии с
 * FetchErrorData из useErrorText.ts, хотя сам /report сегодня отдаёт только
 * error. Ни на shouldRetrySend, ни на судьбу бандла в очереди не влияет.
 */
export function extractServerErrorCode(error: unknown): string | null {
  const e = error as { data?: { errorCode?: unknown; error?: unknown } }
  const code = e?.data?.errorCode ?? e?.data?.error
  return typeof code === 'string' && code.length > 0 ? code : null
}

/** Итог одной попытки отправки бандла из очереди ретрая: 'ok' — ушёл и
 *  больше не нужен; число — сервер ответил этим статусом; null — сетевая
 *  ошибка/таймаут без ответа. */
export type SendAttemptOutcome = 'ok' | number | null

/**
 * Пересчитывает очередь ретрая по итогам одного прохода flushPending().
 * outcomes[i] относится к queue[i]. Бандл уходит из очереди, если он успешно
 * отправлен ('ok') или если shouldRetrySend решил, что сервер его никогда не
 * примет; иначе остаётся для следующей попытки. Обрезка до MAX_PENDING —
 * по-прежнему отдельная забота trimPendingQueue, вызываемой из writePending
 * на каждую запись, — здесь она не дублируется.
 */
export function nextPendingQueue<T>(queue: T[], outcomes: SendAttemptOutcome[]): T[] {
  return queue.filter((_, index) => {
    const outcome = outcomes[index]
    if (outcome === 'ok') return false
    const status = typeof outcome === 'number' ? outcome : null
    return shouldRetrySend(status)
  })
}

// ── Re-review fix (BLOCKING 3 regression): flushPending() без токена ──────
//
// 00.diag.client.ts — самый ранний клиентский плагин — планировал
// flushPending() через requestIdleCallback/setTimeout(0), то есть на первом
// же простое главного потока. apiStore.tokenJWT в этот момент ещё пуст:
// токен приходит позже, через useAppInit → ensureFreshToken → POST
// /api/getToken, уже ПОСЛЕ инициализации фрейма Б24. Без Authorization
// бэкенд отвечает 401, а 401 — это 4xx: shouldRetrySend(401) === false,
// «сервер не примет никогда». flushPending() трактовал это как
// окончательный отказ и СТИРАЛ всю очередь ретрая — не «не смогли
// отправить», а «потеряли». Хуже исходного дефекта (там бандлы просто
// зависали, а не удалялись).
//
// shouldFlushPending() — вынесенное наружу решение «пробовать ли вообще»,
// проверяется ДО единого обращения к сети. Правильный триггер для самой
// попытки — появление токена (см. watch на apiStore.isInitTokenJWT в
// 00.diag.client.ts, тот же паттерн, что и в auth-refresh.client.ts), а не
// «прошло немного времени с холодного старта».

/**
 * Решает, стоит ли запускать flushPending(): нужен и токен (иначе любая
 * попытка гарантированно вернёт 401, который shouldRetrySend не отличит от
 * настоящего «сервер отклонил бандл навсегда»), и непустая очередь
 * (иначе пытаться нечего).
 */
export function shouldFlushPending(hasToken: boolean, queueLength: number): boolean {
  return hasToken && queueLength > 0
}
