/**
 * Признак того, что загрузку фото стоит продолжать бережно (в один поток),
 * а не считать её окончательно проваленной.
 *
 * Два разных источника сигнала:
 *  - ответ сервера — лимиты Битрикса (OPERATION_TIME_LIMIT, 429, 504);
 *  - сама ошибка запроса — обрыв или таймаут, когда ответа нет вовсе.
 *
 * Второй случай на проде основной: реальная отдача канала на части АЗС —
 * 10–20 кбит/с, фото около 100 КБ уходит 45–80 секунд и обрывается по
 * UPLOAD_TIMEOUT_MS. Раньше такие обрывы сюда не доходили (проверялся только
 * ответ сервера), поэтому приложение продолжало грузить в два потока и делило
 * узкий канал пополам.
 */
const RETRYABLE_TEXT = /(OPERATION_TIME_LIMIT|QUERY_LIMIT_EXCEEDED|HTTP 429|HTTP 504|too many requests|gateway timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|failed to fetch|network error|networkerror|timeout|прервана|не ответил вовремя|aborted)/i

export const isRetryableUploadIssue = ({
  errorCode,
  message,
  error
}: {
  errorCode?: string
  message?: string
  error?: unknown
} = {}): boolean => {
  if (String(errorCode || '').trim().toLowerCase() === 'bitrix_retryable') {
    return true
  }

  if (RETRYABLE_TEXT.test(String(message || ''))) {
    return true
  }

  // Ответа сервера нет — смотрим на саму ошибку запроса. AbortError прилетает
  // и от таймаута, и от отмены; в обоих случаях верный ход один — сбавить темп.
  if (error) {
    const name = String((error as { name?: string })?.name || '')
    if (name === 'AbortError' || name === 'TimeoutError') {
      return true
    }
    const text = error instanceof Error ? error.message : String(error)
    if (RETRYABLE_TEXT.test(text)) {
      return true
    }
  }

  return false
}

export default isRetryableUploadIssue
