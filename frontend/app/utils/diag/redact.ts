export const REDACTED = '***'

// Словарь выровнен по utils/maskSecret.js (SENSITIVE_KEYS) и расширен формами,
// которые реально встречаются в текстах ошибок. Порядок важен: длинные варианты
// раньше коротких, иначе `token` съест префикс у `access_token`.
const SECRET_TEXT_KEYS = [
  'access[_-]?token', 'refresh[_-]?token', 'refresh[_-]?id', 'id[_-]?token',
  '[a-z]{2,}[_-]token', 'token',
  'auth[_-]?id', 'authorization', 'auth',
  'session[_-]?id', 'sess[_-]?id', 'sessid', 'session', 'cookie',
  'api[_-]?key', 'client[_-]?secret', 'secret',
  'password', 'passwd', 'pwd'
].join('|')

// Один словарь на все три пути редакции: свободный текст, имена
// query-параметров и имена заголовков. Раздельные списки уже разъезжались —
// текстовый вырос до 20 форм, а query остался на 4, и refresh_id утекал.
const SECRET_KEY_RE = new RegExp(`^(x-)?(${SECRET_TEXT_KEYS})$`, 'i')
// set-cookie не подходит под шаблон, но обязателен к сокрытию.
const EXTRA_SECRET_HEADERS = new Set(['set-cookie'])

const isSecretKey = (name: string): boolean => {
  const normalized = String(name || '').toLowerCase()
  return EXTRA_SECRET_HEADERS.has(normalized) || SECRET_KEY_RE.test(normalized)
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = isSecretKey(key) ? REDACTED : value
  }
  return out
}

export function redactUrl(rawUrl: string): string {
  const raw = String(rawUrl ?? '')
  if (!raw) return ''
  try {
    const url = new URL(raw, 'http://local.invalid')
    let touched = false

    for (const key of Array.from(url.searchParams.keys())) {
      if (isSecretKey(key)) {
        url.searchParams.set(key, REDACTED)
        touched = true
      }
    }

    // Секреты живут и во фрагменте: OAuth-редиректы кладут access_token после
    // '#'. URL не разбирает hash как query-строку, поэтому разбираем вручную.
    if (url.hash.length > 1) {
      const hashParams = new URLSearchParams(url.hash.slice(1))
      let hashTouched = false
      for (const key of Array.from(hashParams.keys())) {
        if (isSecretKey(key)) {
          hashParams.set(key, REDACTED)
          hashTouched = true
        }
      }
      if (hashTouched) {
        url.hash = `#${hashParams.toString()}`
        touched = true
      }
    }

    if (!touched) return raw
    return /^[a-z]+:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  } catch {
    return raw
  }
}

// Запятая и точка с запятой НЕ терминаторы значения: иначе секрет с запятой
// маскируется частично и пригодный огрызок уезжает в базу.
const KV_RE = new RegExp(`\\b(${SECRET_TEXT_KEYS})"?\\s*[=:]\\s*"?([^&\\s"'<>)\\]}]+)`, 'gi')
const BEARER_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{4,})/gi

/**
 * Чистит секреты в свободном тексте — сообщениях об ошибках и стеках.
 *
 * Текст ошибки почти всегда содержит URL упавшего запроса, а stack дублирует
 * message. Разбирать это как URL нельзя: строка произвольная. Поэтому ищем
 * пары «ключ=значение» и схемы авторизации.
 */
export function redactText(text: string): string {
  const raw = String(text ?? '')
  if (!raw) return ''
  return raw
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KV_RE, (_m, key: string) => `${key}=${REDACTED}`)
}
