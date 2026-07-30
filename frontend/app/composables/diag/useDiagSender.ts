/**
 * useDiagSender — отправка диаг-бандла: проба канала, троттлинг, ретрай.
 *
 * Вся арифметика и разбор данных, не зависящие от window/fetch/crypto/
 * performance, вынесены в чистый ~/utils/diag/sendHelpers (покрыт тестами
 * под node --test). Здесь остаётся только оркестрация браузерных API,
 * которую в этом репозитории нельзя прогнать без jsdom/nuxt-test-utils.
 *
 * Правило на весь файл: диагностика не имеет права сорвать сдачу отчёта.
 * Каждый путь — try/catch, отправка fire-and-forget.
 */
import { buildBundle } from '~/utils/diag/buildBundle'
import { shouldSend, trimPendingQueue, MAX_PENDING } from '~/utils/diag/sendPolicy'
import {
  echoBytesForTrigger,
  computeEchoKbps,
  pingMedianMs,
  pingLossPercent,
  buildAuthHeaders,
  resolveApiBase,
  parsePendingJson
} from '~/utils/diag/sendHelpers'
import type { BuildBundleInput, DiagBundle, DiagTrigger } from '~/utils/diag/types'

const LAST_SENT_KEY = 'diag_last_sent_at'
const PENDING_KEY = 'diag_pending'
const PROBE_TIMEOUT_MS = 30_000
const PING_TIMEOUT_MS = 10_000
const PING_ATTEMPTS = 3

type SendMeta = { app: BuildBundleInput['app']; user: BuildBundleInput['user'] }

const readPending = (): DiagBundle[] => {
  try {
    return parsePendingJson(window.localStorage.getItem(PENDING_KEY)) as DiagBundle[]
  } catch { return [] }
}

const writePending = (queue: DiagBundle[]): void => {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(trimPendingQueue(queue, MAX_PENDING)))
  } catch { /* переполнен localStorage — не наша забота в этот момент */ }
}

export const useDiagSender = () => {
  const collector = useDiagCollector()
  const apiStore = useApiStore()
  const config = useRuntimeConfig()
  const apiUrl = resolveApiBase(config.public.apiUrl)

  const authHeaders = (): Record<string, string> => buildAuthHeaders(apiStore.tokenJWT)

  /** Замер канала, изолированный от Диска Битрикса: echo принимает байты и сразу отвечает.
   *  Размер пробы (echoBytesForTrigger) различается по триггеру — обоснование
   *  и точные значения см. в ~/utils/diag/sendHelpers.ts у ECHO_BYTES_BY_TRIGGER. */
  const probe = async (trigger: DiagTrigger): Promise<BuildBundleInput['probe']> => {
    const result: BuildBundleInput['probe'] = {
      echoBytes: null, echoMs: null, echoKbps: null, pingMsMedian: null, pingLoss: null
    }

    const echoBytes = echoBytesForTrigger(trigger)

    try {
      const payload = new Uint8Array(echoBytes)
      crypto.getRandomValues(payload.subarray(0, Math.min(65_536, echoBytes)))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      const startedAt = performance.now()
      try {
        await fetch(`${apiUrl}/api/diag/echo`, {
          method: 'POST',
          body: payload,
          signal: controller.signal,
          headers: { 'Content-Type': 'application/octet-stream', ...authHeaders() }
        })
        const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt))
        result.echoBytes = echoBytes
        result.echoMs = elapsedMs
        result.echoKbps = computeEchoKbps(echoBytes, elapsedMs)
      } finally { clearTimeout(timer) }
    } catch { /* канал мёртв — поля остаются null, это тоже сигнал */ }

    const samples: number[] = []
    let lost = 0
    for (let i = 0; i < PING_ATTEMPTS; i += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
      const startedAt = performance.now()
      try {
        await fetch(`${apiUrl}/api/diag/ping`, { signal: controller.signal, headers: authHeaders() })
        samples.push(performance.now() - startedAt)
      } catch { lost += 1 } finally { clearTimeout(timer) }
    }
    result.pingMsMedian = pingMedianMs(samples)
    result.pingLoss = pingLossPercent(lost, PING_ATTEMPTS)

    return result
  }

  const post = async (bundle: DiagBundle): Promise<string | null> => {
    const response = await $fetch<{ code: string }>(`${apiUrl}/api/diag/report`, {
      method: 'POST',
      body: bundle,
      headers: { 'Content-Type': 'application/json', ...authHeaders() }
    })
    return response?.code ?? null
  }

  /**
   * Дожимает ранее сохранённые бандлы (пришли позже — сеть/бэкенд были недоступны
   * в момент send()). Троттлинг здесь не применяется: это не новая проба канала,
   * а попытка досдать то, что уже было измерено и лежит на устройстве.
   *
   * Примечание: post() бросает на любой не-2xx ответ (ofetch), поэтому 400
   * от бэкенда (например, бандл не проходит sanitizeBundle) неотличим здесь
   * от временной сетевой ошибки — оба пути одинаково кладут бандл обратно в
   * remaining и он останется в очереди до следующего flushPending(). Если
   * бэкенд стабильно отвечает 400 на конкретный бандл, тот будет пытаться
   * уйти на каждом вызове flushPending(), пока его не вытеснят более новые
   * неудачные попытки (см. trimPendingQueue — предел MAX_PENDING=3, вытесняется
   * самое старое). Различать «навсегда сломан» и «попробовать ещё раз» здесь
   * не реализовано — см. отчёт по задаче.
   */
  const flushPending = async (): Promise<void> => {
    const queue = readPending()
    if (queue.length === 0) return
    const remaining: DiagBundle[] = []
    for (const bundle of queue) {
      try { await post(bundle) } catch { remaining.push(bundle) }
    }
    writePending(remaining)
  }

  const send = async (trigger: DiagTrigger, meta: SendMeta): Promise<{ ok: boolean; code: string | null }> => {
    try {
      // Троттлинг проверяется до пробы (probe ниже ждёт до PROBE_TIMEOUT_MS+3*PING_TIMEOUT_MS
      // при мёртвом канале) — иначе заброшенный из-за троттлинга вызов всё равно
      // тратил бы десятки секунд умирающего канала на измерение, результат которого
      // тут же выбрасывается.
      const lastRaw = window.localStorage.getItem(LAST_SENT_KEY)
      const lastSentAtMs = lastRaw === null ? null : Number(lastRaw)
      if (!shouldSend(lastSentAtMs, Date.now())) return { ok: false, code: null }
      window.localStorage.setItem(LAST_SENT_KEY, String(Date.now()))

      const probeResult = await probe(trigger)
      const bundle = buildBundle({ ...collector.collectInput({ trigger, ...meta }), probe: probeResult })

      try {
        const code = await post(bundle)
        return { ok: true, code }
      } catch {
        writePending([...readPending(), bundle])
        return { ok: false, code: null }
      }
    } catch {
      return { ok: false, code: null }
    }
  }

  return { send, flushPending }
}
