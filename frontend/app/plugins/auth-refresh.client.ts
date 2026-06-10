/**
 * auth-refresh.client.ts — preventive JWT refresh.
 *
 * The backend issues JWTs with TTL=1h (`server.js:/api/getToken`). Without a
 * preventive refresh, the very first API call after the 1h boundary throws a
 * 401 — the api store does silently recover via the 401 interceptor, but
 * that interceptor adds a noticeable round-trip on the first user click after
 * an hour of inactivity (e.g. a station admin returning to the camera screen
 * after a long shift).
 *
 * This plugin refreshes the JWT every ~50 minutes while the tab is alive, so
 * the token is virtually always fresh under normal use. The 401 interceptor
 * remains the safety net for tabs that were backgrounded or for clock skew.
 *
 * Behaviour:
 *  - Starts the timer the moment a JWT is first issued (waits via watch).
 *  - Pauses while the tab is hidden (visibilitychange) — re-runs on resume.
 *  - Stops on `beforeunload` to avoid pending fetches during navigation away.
 */

const REFRESH_INTERVAL_MS = 50 * 60 * 1000 // 50 minutes — JWT TTL is 60 min

export default defineNuxtPlugin(() => {
  const apiStore = useApiStore()

  let timer: ReturnType<typeof setInterval> | null = null
  let started = false

  const refresh = async () => {
    try {
      await apiStore.ensureFreshToken({ force: true })
    } catch (error) {
      // Failure here is non-fatal — the 401 interceptor will catch the next
      // expired-token error. We log so prod logs surface chronic refresh issues.
      console.warn('preventive JWT refresh failed', error)
    }
  }

  const start = () => {
    if (started || timer) return
    started = true
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void refresh()
    }, REFRESH_INTERVAL_MS)
  }

  // Named handler so stop() can remove it via removeEventListener.
  const onVisibility = () => {
    if (!document.hidden && started) {
      // Coming back from background — refresh once immediately so the
      // user's first click is on a fresh token even if the timer slept.
      void refresh()
    }
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  // Wait for the first JWT issuance (init() in api store) before arming
  // the preventive refresh — otherwise the first tick would race the install
  // flow and throw "B24 non init".
  watch(
    () => apiStore.isInitTokenJWT,
    (ready) => {
      if (ready) start()
    },
    { immediate: true }
  )

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', stop)
    document.addEventListener('visibilitychange', onVisibility)
  }
})
