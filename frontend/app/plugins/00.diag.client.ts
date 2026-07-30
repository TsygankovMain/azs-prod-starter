/**
 * Диаг-рекордер. Ставится на буте, до инициализации фрейма и первых вызовов API.
 *
 * Что делает:
 *  1) оборачивает globalThis.fetch — все вызовы через $fetch (stores/api.ts:110
 *     создаёт клиент как $fetch.create, то есть ofetch поверх globalThis.fetch)
 *     попадают в буфер;
 *  2) добавляет заголовок X-Diag-Session на запросы к нашему origin — это точка
 *     сцепки для этапа 2, где к бандлу подклеивается серверная половина;
 *  3) подписывается на window.onerror и unhandledrejection — по B2 у нас до сих
 *     пор нет ни одного текста ошибки.
 *
 * Любой сбой рекордера гасится: диагностика не имеет права ломать сдачу отчёта.
 */
import { isOwnOriginRequestUrl, resolveRequestMethod, resolveRequestUrl } from '~/utils/diag/netCapture'

export default defineNuxtPlugin(() => {
  if (typeof window === 'undefined') return

  // Плагин обязан переживать повторный запуск (HMR в dev, повторный импорт
  // модуля) без повторной обёртки fetch и повторной подписки на window-
  // события — иначе один реальный запрос или одна ошибка задваиваются в
  // буферах (netBuf/errorBuf — модульные синглтоны в useDiagCollector, вторая
  // обёртка пишет в них же). Тот же приём — в 00.demo.client.ts (__demoFetchPatched).
  const w = window as Window & { __diagRecorderInstalled?: boolean }
  if (w.__diagRecorderInstalled) return
  w.__diagRecorderInstalled = true

  const { diagSessionId, recordNet, recordError } = useDiagCollector()
  const originalFetch = globalThis.fetch.bind(globalThis)
  const appOrigin = window.location.origin

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAtMs = performance.now()
    const startedAt = new Date().toISOString()
    const url = resolveRequestUrl(input)
    const method = resolveRequestMethod(input, init)

    let patchedInit = init
    try {
      if (isOwnOriginRequestUrl(url, appOrigin)) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
        headers.set('X-Diag-Session', diagSessionId)
        patchedInit = { ...init, headers }
      }
    } catch { /* заголовок не критичен — продолжаем без него */ }

    try {
      const response = await originalFetch(input, patchedInit)
      try {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => { headers[key] = value })
        recordNet({
          url, method, status: response.status, startedAt,
          durationMs: Math.round(performance.now() - startedAtMs),
          reqBytes: 0,
          resBytes: Number(response.headers.get('content-length') || 0),
          headers
        })
      } catch { /* запись в буфер не должна влиять на ответ */ }
      return response
    } catch (error) {
      try {
        recordNet({
          url, method, status: 0, startedAt,
          durationMs: Math.round(performance.now() - startedAtMs),
          reqBytes: 0, resBytes: 0,
          headers: { 'x-diag-network-error': String((error as Error)?.message || error) }
        })
      } catch { /* см. выше */ }
      throw error
    }
  }

  window.addEventListener('error', (event: ErrorEvent) => {
    try {
      recordError({
        kind: 'onerror',
        message: String(event.message || ''),
        stack: event.error instanceof Error ? event.error.stack : undefined,
        source: String(event.filename || ''),
        line: Number(event.lineno || 0),
        col: Number(event.colno || 0),
        at: new Date().toISOString()
      })
    } catch { /* игнорируем */ }
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    try {
      const reason = event.reason
      recordError({
        kind: 'unhandledrejection',
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        source: '', line: 0, col: 0,
        at: new Date().toISOString()
      })
    } catch { /* игнорируем */ }
  })
})
