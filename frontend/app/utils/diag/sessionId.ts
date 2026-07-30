/**
 * Чистая логика выбора id диаг-сессии. Вынесена из
 * composables/diag/useDiagCollector.ts по прецеденту netCapture.ts/
 * sendHelpers.ts: сам composable трогает window.sessionStorage и crypto —
 * не тестируется напрямую под node --test, а выбор источника id и генерация
 * фолбэка от них не зависят, значит их можно и нужно проверить тестами.
 *
 * Fix round (ревью feat/diag-bundle-stage1, BLOCKING 4): getOrCreateSessionId()
 * дёргал crypto.randomUUID() не глядя. Вне secure context (обычный http://,
 * часть встраиваний Битрикс24 в iframe) crypto.randomUUID не определён —
 * throw здесь долетал до вызывающего кода. В admin/[reportId].client.vue
 * такой throw пропускал finally у runUploadTask, activeCount не уменьшался,
 * и очередь загрузки фото останавливалась навсегда. Id сессии — не секрет,
 * только группировка записей в буфере на время вкладки, поэтому
 * криптостойкий фолбэк не нужен, важно только не бросить.
 */

const FALLBACK_PREFIX = 'mem-'

/**
 * Генератор id, когда crypto.randomUUID недоступен. now/randomValue —
 * необязательные параметры для детерминированных тестов; в бою вызывается
 * без аргументов (реальные Date.now()/Math.random()).
 */
export const generateFallbackSessionId = (
  now: number = Date.now(),
  randomValue: number = Math.random()
): string => `${FALLBACK_PREFIX}${now.toString(36)}-${randomValue.toString(36).slice(2, 10)}`

/**
 * Выбирает id сессии: предпочитает randomUUID, если он передан, вызывается
 * и возвращает непустую строку; иначе — фолбэк в памяти вкладки.
 *
 * randomUUID приходит аргументом от вызывающего composable (который решает,
 * откуда его взять — обычно crypto?.randomUUID?.bind(crypto)) — эта функция
 * ничего не знает про crypto/window и поэтому тестируется без браузерных
 * API. throw изнутри randomUUID и пустая строка трактуются одинаково —
 * как «источник недоступен», никогда не пробрасываются наружу.
 */
export const resolveSessionId = (randomUUID?: () => string): string => {
  if (typeof randomUUID === 'function') {
    try {
      const id = randomUUID()
      if (id) return id
    } catch {
      // randomUUID может бросить вне secure context — переходим к фолбэку
    }
  }
  return generateFallbackSessionId()
}
