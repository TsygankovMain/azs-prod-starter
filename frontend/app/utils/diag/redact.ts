const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key'])
const SECRET_QUERY_KEYS = new Set(['token', 'access_token', 'auth', 'sessid'])

export const REDACTED = '***'

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? REDACTED : value
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
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
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
        if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
          hashParams.set(key, REDACTED)
          hashTouched = true
        }
      }
      if (hashTouched) {
        url.hash = hashParams.toString()
        touched = true
      }
    }

    if (!touched) return raw
    return /^[a-z]+:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  } catch {
    return raw
  }
}

const SECRET_TEXT_KEYS = 'token|access_token|refresh_token|auth|sessid|api_key|apikey'
const KV_RE = new RegExp(`\\b(${SECRET_TEXT_KEYS})"?\\s*[=:]\\s*"?([^&\\s"'<>)\\]},;]+)"?`, 'gi')
const BEARER_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi

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
    .replace(KV_RE, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
}
