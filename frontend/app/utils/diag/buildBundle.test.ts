import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBundle, MAX_BUNDLE_BYTES } from './buildBundle.ts'
import type { BuildBundleInput } from './types.ts'

const baseInput = (): BuildBundleInput => ({
  diagSessionId: 'sess-1',
  sentAt: '2026-07-30T09:00:00.000Z',
  trigger: 'button',
  app: { build: 'dev', route: '/admin/1', isDemo: false },
  user: { userId: 498, azsId: '548', reportId: 12345, role: 'azs_admin' },
  device: { userAgent: 'UA', deviceMemory: 4, hardwareConcurrency: 8, screen: { w: 390, h: 844, dpr: 3 }, language: 'ru', platform: 'Android' },
  network: { onLine: true, effectiveType: '3g', downlink: 0.4, rtt: 1200, saveData: false },
  probe: { echoBytes: 307200, echoMs: 6000, echoKbps: 409, pingMsMedian: 180, pingLoss: 0 },
  startup: { navigationMs: 5300, ttfbMs: 900, domContentLoadedMs: 2100, resourceCount: 42 },
  queue: { activeCount: 1, maxConcurrency: 2, workerSessionId: 1, slots: [] },
  uploads: [],
  net: [],
  errors: [],
  b24: [],
  dropped: { net: 0, errors: 0, uploads: 0 }
})

test('переносит вход в бандл и ставит версию', () => {
  const bundle = buildBundle(baseInput())
  assert.equal(bundle.v, 1)
  assert.equal(bundle.diagSessionId, 'sess-1')
  assert.equal(bundle.user.azsId, '548')
  assert.equal(bundle.probe.echoKbps, 409)
})

test('редактирует секреты в net-записях', () => {
  const input = baseInput()
  input.net = [{
    url: '/api/reports?token=abc',
    method: 'GET',
    status: 200,
    startedAt: '2026-07-30T09:00:00.000Z',
    durationMs: 120,
    reqBytes: 0,
    resBytes: 512,
    headers: { Authorization: 'Bearer secret', 'X-Ok': 'keep' }
  }]
  const bundle = buildBundle(input)
  assert.equal(bundle.net[0]!.url, '/api/reports?token=***')
  assert.equal(bundle.net[0]!.headers.Authorization, '***')
  assert.equal(bundle.net[0]!.headers['X-Ok'], 'keep')
})

test('обрезает net при превышении потолка размера и отмечает это в dropped', () => {
  const input = baseInput()
  const bigHeaders: Record<string, string> = {}
  for (let h = 0; h < 40; h += 1) bigHeaders[`x-pad-${h}`] = 'p'.repeat(200)
  input.net = Array.from({ length: 150 }, (_, i) => ({
    url: `/api/reports/${i}`,
    method: 'GET',
    status: 200,
    startedAt: '2026-07-30T09:00:00.000Z',
    durationMs: 10,
    reqBytes: 0,
    resBytes: 0,
    headers: bigHeaders
  }))
  const bundle = buildBundle(input)
  const size = new TextEncoder().encode(JSON.stringify(bundle)).length
  assert.ok(size <= MAX_BUNDLE_BYTES, `размер ${size} должен быть <= ${MAX_BUNDLE_BYTES}`)
  assert.ok(bundle.net.length < 150)
  assert.ok(bundle.dropped.net > 0)
})

test('ошибки без stack не роняют сборку', () => {
  const input = baseInput()
  input.errors = [{ kind: 'onerror', message: 'boom', stack: undefined, source: 'app.js', line: 1, col: 2, at: '2026-07-30T09:00:00.000Z' }]
  const bundle = buildBundle(input)
  assert.equal(bundle.errors[0]!.message, 'boom')
})

test('MAX_BUNDLE_BYTES зафиксирован', () => {
  assert.equal(MAX_BUNDLE_BYTES, 262144)
})

test('скрывает секреты в текстах ошибок и загрузок', () => {
  const input = baseInput()
  input.errors = [{
    kind: 'onerror', message: 'POST /api/reports?token=LEAK failed',
    stack: 'Error: token=LEAK\n  at x', source: 'app.js', line: 1, col: 2,
    at: '2026-07-30T09:00:00.000Z'
  }]
  input.uploads = [{
    photoCode: 'p1', fileSize: 10, fileType: 'image/jpeg', exifTakenAt: null,
    startedAt: '2026-07-30T09:00:00.000Z', durationMs: 5, outcome: 'error',
    httpStatus: 502, errorCode: 'X', retryable: true, attempt: 1,
    message: 'sessid=LEAK'
  }]
  input.queue.slots = [{
    key: 'p1', confirmed: true, uploadState: 'error', uploaded: false,
    fileSize: 10, fileType: 'image/jpeg', error: 'auth=LEAK'
  }]
  const bundle = buildBundle(input)
  assert.ok(!JSON.stringify(bundle).includes('LEAK'), JSON.stringify(bundle))
})

test('обрезка доходит до потолка, даже когда net и b24 пусты', () => {
  const input = baseInput()
  input.errors = Array.from({ length: 50 }, (_, i) => ({
    kind: 'onerror' as const, message: `boom ${i} ${'x'.repeat(6000)}`,
    stack: 'y'.repeat(6000), source: 'app.js', line: i, col: 0,
    at: '2026-07-30T09:00:00.000Z'
  }))
  const bundle = buildBundle(input)
  const size = new TextEncoder().encode(JSON.stringify(bundle)).length
  assert.ok(size <= MAX_BUNDLE_BYTES, `размер ${size} должен быть <= ${MAX_BUNDLE_BYTES}`)
  assert.ok(bundle.dropped.errors > 0, 'сброс ошибок должен быть отмечен в dropped.errors')
})

test('b24 усекается, когда net уже пуст', () => {
  const input = baseInput()
  input.b24 = Array.from({ length: 100 }, (_, i) => ({
    method: `m${i}${'z'.repeat(4000)}`, durationMs: 1, ok: false, errorCode: 'E'
  }))
  const bundle = buildBundle(input)
  const size = new TextEncoder().encode(JSON.stringify(bundle)).length
  assert.ok(size <= MAX_BUNDLE_BYTES, `размер ${size}`)
  assert.ok(bundle.b24.length < 100)
})
