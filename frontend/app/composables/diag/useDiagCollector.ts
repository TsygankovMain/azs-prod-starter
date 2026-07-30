/**
 * useDiagCollector — singleton-хранилище диаг-бандла на клиенте.
 *
 * Кольцевые буферы и снимок очереди живут на уровне модуля (не внутри
 * функции), поэтому все вызовы useDiagCollector() в приложении делят одно
 * и то же состояние — ровно то, что нужно: плагин пишет в буферы с холодного
 * старта, а кнопка «не работает» (более поздний этап) читает их через
 * collectInput() в любой момент жизни вкладки.
 *
 * collectInput() возвращает Omit<BuildBundleInput, 'probe'> — поле probe
 * (проба канала) дозаполняет отправитель бандла в отдельной задаче.
 */
import { createRingBuffer } from '~/utils/diag/ringBuffer'
import type {
  B24Entry, BuildBundleInput, DiagTrigger, ErrorEntry, NetEntry, QueueSnapshot, UploadEntry
} from '~/utils/diag/types'

const SESSION_KEY = 'diag_session_id'

const CAPS = { net: 150, errors: 50, uploads: 60, b24: 100 } as const

const netBuf = createRingBuffer<NetEntry>(CAPS.net)
const errorBuf = createRingBuffer<ErrorEntry>(CAPS.errors)
const uploadBuf = createRingBuffer<UploadEntry>(CAPS.uploads)
const b24Buf = createRingBuffer<B24Entry>(CAPS.b24)

let queueSnapshot: QueueSnapshot = { activeCount: 0, maxConcurrency: 0, workerSessionId: 0, slots: [] }
let sessionId = ''

const getOrCreateSessionId = (): string => {
  if (sessionId) return sessionId
  if (typeof window === 'undefined') return 'ssr'
  const stored = window.sessionStorage.getItem(SESSION_KEY)
  if (stored) { sessionId = stored; return sessionId }
  sessionId = crypto.randomUUID()
  window.sessionStorage.setItem(SESSION_KEY, sessionId)
  return sessionId
}

const readNetwork = (): BuildBundleInput['network'] => {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean }
  }
  const c = nav.connection
  return {
    onLine: Boolean(navigator.onLine),
    effectiveType: c?.effectiveType ?? null,
    downlink: typeof c?.downlink === 'number' ? c.downlink : null,
    rtt: typeof c?.rtt === 'number' ? c.rtt : null,
    saveData: typeof c?.saveData === 'boolean' ? c.saveData : null
  }
}

const readDevice = (): BuildBundleInput['device'] => {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    userAgent: navigator.userAgent,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    screen: { w: window.screen?.width ?? 0, h: window.screen?.height ?? 0, dpr: window.devicePixelRatio ?? 1 },
    language: navigator.language || '',
    platform: navigator.platform || ''
  }
}

const readStartup = (): BuildBundleInput['startup'] => {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const resources = performance.getEntriesByType('resource')
  return {
    navigationMs: nav ? Math.round(nav.duration) : null,
    ttfbMs: nav ? Math.round(nav.responseStart) : null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    resourceCount: resources.length
  }
}

export const useDiagCollector = () => ({
  diagSessionId: getOrCreateSessionId(),
  recordNet: (entry: NetEntry): void => { netBuf.push(entry) },
  recordError: (entry: ErrorEntry): void => { errorBuf.push(entry) },
  recordUpload: (entry: UploadEntry): void => { uploadBuf.push(entry) },
  recordB24: (entry: B24Entry): void => { b24Buf.push(entry) },
  setQueueSnapshot: (snapshot: QueueSnapshot): void => { queueSnapshot = snapshot },

  collectInput: (meta: {
    trigger: DiagTrigger
    app: BuildBundleInput['app']
    user: BuildBundleInput['user']
  }): Omit<BuildBundleInput, 'probe'> => ({
    diagSessionId: getOrCreateSessionId(),
    sentAt: new Date().toISOString(),
    trigger: meta.trigger,
    app: meta.app,
    user: meta.user,
    device: readDevice(),
    network: readNetwork(),
    startup: readStartup(),
    queue: queueSnapshot,
    uploads: uploadBuf.toArray(),
    net: netBuf.toArray(),
    errors: errorBuf.toArray(),
    b24: b24Buf.toArray(),
    dropped: { net: netBuf.dropped, errors: errorBuf.dropped, uploads: uploadBuf.dropped }
  })
})
