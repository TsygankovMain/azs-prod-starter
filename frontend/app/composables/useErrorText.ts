/**
 * useErrorText — human-readable RU error messages for backend typed error codes.
 *
 * The backend response shape on error (from $fetch):
 *   error.data?.errorCode  — typed constant (authoritative)
 *   error.data?.message    — legacy human text (fallback detail)
 *   error.data?.error      — legacy snake_case code (fallback detail)
 *
 * Usage:
 *   const { errorText, errorDetail } = useErrorText()
 *   errorText(err)               — main user-facing message
 *   errorText(err, 'Fallback')   — override the default fallback
 *   errorDetail(err)             — raw technical string for <details> spoiler
 */

/** Shape of the data payload that $fetch throws on non-2xx responses. */
interface FetchErrorData {
  errorCode?: string
  message?: string
  error?: string
}

/** Error thrown by $fetch — data lives on .data */
interface FetchLike {
  data?: FetchErrorData | unknown
}

const ERROR_MESSAGES: Record<string, string> = {
  AZS_PHOTO_SET_EMPTY: 'Для вашей АЗС не настроен список фото. Сообщите администратору.',
  AZS_CARD_NOT_FOUND: 'Карточка АЗС не найдена в CRM. Сообщите администратору.',
  PHOTO_TYPE_NOT_FOUND: 'Справочник типов фото недоступен. Сообщите администратору.',
  REPORT_NOT_FOUND: 'Отчёт не найден. Обновите страницу.',
  PHOTO_CODE_NOT_REQUIRED: 'Этот тип фото не входит в текущее задание. Обновите страницу.',
  PHOTO_EXIF_TOO_OLD: 'Фото сделано слишком давно — нужен свежий снимок.',
  REPORT_PHOTOS_MISSING: 'Загружены не все обязательные фото.',
  RECIPIENT_NOT_SET: 'У АЗС не указан получатель. Выберите администратора.',
  REMARK_NOT_FOUND: 'Замечание не найдено.',
  PHOTOS_AZS_MISMATCH: 'Часть выбранных фото относится к другой АЗС. Обновите страницу и попробуйте снова.',
  BOT_UNAVAILABLE: 'Рассылка сейчас недоступна: нет связи с Битрикс24. Попробуйте позже или переоткройте приложение.',
}

const DEFAULT_FALLBACK = 'Не получилось. Попробуйте ещё раз или сообщите администратору.'

function extractData(err: unknown): FetchErrorData {
  if (!err || typeof err !== 'object') return {}
  const data = (err as FetchLike).data
  if (!data || typeof data !== 'object') return {}
  return data as FetchErrorData
}

export const useErrorText = () => {
  /**
   * Returns a human-readable RU string for the given error.
   * Looks up errorCode in the dictionary first; falls back to the provided
   * fallback or the default fallback message.
   */
  const errorText = (err: unknown, fallback?: string): string => {
    const data = extractData(err)
    const code = String(data.errorCode ?? '').trim()
    if (code && ERROR_MESSAGES[code]) {
      return ERROR_MESSAGES[code]
    }
    return fallback ?? DEFAULT_FALLBACK
  }

  /**
   * Returns the raw technical detail (message / error field) for use inside a
   * <details> spoiler. Never shown as primary UI text.
   */
  const errorDetail = (err: unknown): string => {
    const data = extractData(err)
    const parts: string[] = []
    const code = String(data.errorCode ?? '').trim()
    if (code) parts.push(code)
    const msg = String(data.message ?? '').trim()
    if (msg) parts.push(msg)
    const legacyErr = String(data.error ?? '').trim()
    if (legacyErr && legacyErr !== msg) parts.push(legacyErr)
    if (parts.length) return parts.join(' · ')
    // Fallback to Error.message for non-fetch errors
    if (err instanceof Error) return err.message
    return String(err ?? '')
  }

  return { errorText, errorDetail }
}
