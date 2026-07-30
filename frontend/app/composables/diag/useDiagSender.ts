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
  parsePendingJson,
  shouldRetrySend,
  extractHttpStatus,
  extractServerErrorCode,
  nextPendingQueue
} from '~/utils/diag/sendHelpers'
import type { BuildBundleInput, DiagBundle, DiagTrigger } from '~/utils/diag/types'
import type { SendAttemptOutcome } from '~/utils/diag/sendHelpers'

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
   * Fix round 1: раньше любой отказ post() (сетевой сбой, 5xx, 4xx) одинаково
   * возвращал бандл в очередь — бандл, который сервер бракует 400-м навсегда
   * (битая версия, неизвестный триггер, превышен потолок), ретраился бы на
   * каждом flushPending() бесконечно, до 256 КБ за попытку на том самом
   * канале, который эта проба должна беречь. Теперь судьба каждого бандла
   * решается через shouldRetrySend(extractHttpStatus(error)): 4xx — дроп из
   * очереди с логом (см. console.warn ниже), сетевой сбой/5xx — остаётся для
   * следующей попытки. nextPendingQueue() пересчитывает итоговую очередь по
   * этому правилу; финальную обрезку до MAX_PENDING по-прежнему делает
   * writePending()/trimPendingQueue().
   */
  const flushPending = async (): Promise<void> => {
    const queue = readPending()
    if (queue.length === 0) return
    const outcomes: SendAttemptOutcome[] = []
    for (const bundle of queue) {
      try {
        await post(bundle)
        outcomes.push('ok')
      } catch (error) {
        const status = extractHttpStatus(error)
        if (!shouldRetrySend(status)) {
          console.warn('[diag] бандл из очереди ретрая отклонён окончательно, дропаем', {
            status, serverErrorCode: extractServerErrorCode(error)
          })
        }
        outcomes.push(status)
      }
    }
    writePending(nextPendingQueue(queue, outcomes))
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
      } catch (error) {
        // Fix round 1: 4xx от бэкенда — «этот бандл не примут никогда»
        // (битая версия, неизвестный триггер, превышен потолок), в очередь
        // ретрая его класть нет смысла — он занял бы один из 3 слотов и
        // тратил бы канал на каждом будущем flushPending() без всякого шанса
        // на успех. Сетевой сбой/таймаут/5xx — единственные случаи, когда
        // повтор может помочь, только они и попадают в очередь.
        const status = extractHttpStatus(error)
        if (shouldRetrySend(status)) {
          writePending([...readPending(), bundle])
        } else {
          console.warn('[diag] бэкенд отклонил бандл окончательно, в очередь ретрая не ставим', {
            status, serverErrorCode: extractServerErrorCode(error)
          })
        }
        return { ok: false, code: null }
      }
    } catch {
      return { ok: false, code: null }
    }
  }

  return { send, flushPending }
}
