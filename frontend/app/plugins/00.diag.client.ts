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
// Fix round (ревью, BLOCKING 1): composables/diag/ — вложенная папка,
// Nuxt авто-импортирует только верхний уровень app/composables/. Без явного
// import это падало ReferenceError на первом клиентском тике, а поскольку
// error.vue сам рендерит DiagButton (→ useDiagSender → useDiagCollector),
// экран ошибки падал вместе с приложением.
import { useDiagCollector } from '~/composables/diag/useDiagCollector'
import { useDiagSender } from '~/composables/diag/useDiagSender'

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

  // Fix round (ревью, BLOCKING 4): useDiagCollector() теперь сам по себе не
  // бросает (см. useDiagCollector.ts), но этот плагин — самая ранняя точка
  // загрузки клиента, и throw здесь на первом тике роняет весь плагин
  // (вместе с ним — обёртку fetch и подписки на window-ошибки ниже), а из-за
  // того, что error.vue сам рендерит DiagButton, падает и экран ошибки.
  // Вторая, независимая линия защиты: сбой сборщика не должен стоить
  // приложению обёртки fetch.
  let diagSessionId = ''
  let recordNet: ReturnType<typeof useDiagCollector>['recordNet'] = () => {}
  let recordError: ReturnType<typeof useDiagCollector>['recordError'] = () => {}
  try {
    const collector = useDiagCollector()
    diagSessionId = collector.diagSessionId
    recordNet = collector.recordNet
    recordError = collector.recordError
  } catch { /* см. комментарий выше — плагин обязан подняться без диагностики */ }

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

  // Fix round (ревью, BLOCKING 3): flushPending() дожимает бандлы, которые
  // не отправились раньше (сбой сети/5xx — см. useDiagSender.ts) и осели в
  // localStorage. Функция существовала, но её никто не вызывал — очередь
  // ретрая только росла, а операторский тост в DiagButton.vue обещал, что
  // сохранённая диагностика «уйдёт, когда появится связь», хотя её отправку
  // никто не запускал.
  //
  // Re-review fix: первая версия этого фикса планировала flushPending()
  // через requestIdleCallback/setTimeout(0) — оба срабатывают на первом же
  // простое, задолго до того, как apiStore.tokenJWT вообще появится
  // (stores/api.ts: tokenJWT = ref('') изначально, реальный токен приходит
  // через useAppInit → ensureFreshToken → POST /api/getToken уже ПОСЛЕ
  // инициализации фрейма Б24). Без Authorization бэкенд отвечал 401, а
  // 401 — это 4xx: shouldRetrySend(401) === false, «сервер не примет
  // никогда». flushPending() трактовал это как окончательный отказ и СТИРАЛ
  // всю очередь ретрая — не «не смогли отправить», а «потеряли». Это было
  // хуже исходного дефекта (там бандлы просто зависали, а не удалялись).
  //
  // Правильный триггер — не «прошло немного времени», а «токен появился».
  // Тот же паттерн, что и в auth-refresh.client.ts: watch(...,
  // { immediate: true }) на apiStore.isInitTokenJWT, срабатывает один раз
  // при первом переходе в true (pendingFlushed ниже не даёт повторить это
  // при последующих изменениях токена — обновление токена не должно снова
  // и снова пытаться дожать уже пустую или уже обработанную очередь).
  // useDiagSender.flushPending() тоже сам отказывается работать без токена
  // (см. useDiagSender.ts) — вторая, независимая линия защиты от того же
  // сценария, на случай если flushPending() когда-нибудь вызовут раньше
  // токена откуда-то ещё.
  let pendingFlushed = false
  try {
    const apiStore = useApiStore()
    watch(
      () => apiStore.isInitTokenJWT,
      (ready) => {
        if (!ready || pendingFlushed) return
        pendingFlushed = true
        try {
          useDiagSender().flushPending().catch(() => { /* flushPending уже не бросает — это перестраховка */ })
        } catch { /* диагностика не имеет права ломать сдачу отчёта */ }
      },
      { immediate: true }
    )
  } catch { /* useApiStore()/watch недоступны — тихая деградация */ }
})
