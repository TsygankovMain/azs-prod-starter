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
