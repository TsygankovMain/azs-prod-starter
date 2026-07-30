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
    if (!touched) return raw
    return /^[a-z]+:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}`
  } catch {
    return raw
  }
}
