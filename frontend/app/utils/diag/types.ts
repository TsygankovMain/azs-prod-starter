export type DiagTrigger = 'button' | 'auto_upload_error'

export type NetEntry = {
  url: string
  method: string
  status: number
  startedAt: string
  durationMs: number
  reqBytes: number
  resBytes: number
  headers: Record<string, string>
}

export type ErrorEntry = {
  kind: 'onerror' | 'unhandledrejection' | 'console'
  message: string
  stack: string | undefined
  source: string
  line: number
  col: number
  at: string
}

export type UploadEntry = {
  photoCode: string
  fileSize: number
  fileType: string
  exifTakenAt: string | null
  startedAt: string
  durationMs: number
  outcome: 'ok' | 'error'
  httpStatus: number | null
  errorCode: string | null
  retryable: boolean | null
  attempt: number
  message: string
}

export type B24Entry = { method: string; durationMs: number; ok: boolean; errorCode: string | null }

export type QueueSlotSnapshot = {
  key: string
  confirmed: boolean
  uploadState: string
  uploaded: boolean
  fileSize: number
  fileType: string
  error: string
}

export type QueueSnapshot = {
  activeCount: number
  maxConcurrency: number
  workerSessionId: number
  slots: QueueSlotSnapshot[]
}

export type BuildBundleInput = {
  diagSessionId: string
  sentAt: string
  trigger: DiagTrigger
  app: { build: string; route: string; isDemo: boolean }
  user: { userId: number; azsId: string; reportId: number | null; role: string }
  device: {
    userAgent: string
    deviceMemory: number | null
    hardwareConcurrency: number | null
    screen: { w: number; h: number; dpr: number }
    language: string
    platform: string
  }
  network: {
    onLine: boolean
    effectiveType: string | null
    downlink: number | null
    rtt: number | null
    saveData: boolean | null
  }
  probe: {
    echoBytes: number | null
    echoMs: number | null
    echoKbps: number | null
    pingMsMedian: number | null
    pingLoss: number | null
  }
  startup: {
    navigationMs: number | null
    ttfbMs: number | null
    domContentLoadedMs: number | null
    resourceCount: number
  }
  queue: QueueSnapshot
  uploads: UploadEntry[]
  net: NetEntry[]
  errors: ErrorEntry[]
  b24: B24Entry[]
  dropped: { net: number; errors: number; uploads: number }
}

export type DiagBundle = BuildBundleInput & { v: 1 }
