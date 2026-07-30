import { redactHeaders, redactUrl } from './redact.ts'
import type { BuildBundleInput, DiagBundle } from './types.ts'

export const MAX_BUNDLE_BYTES = 262_144

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length

/**
 * Собирает диаг-бандл из уже накопленного состояния.
 *
 * Чистая функция: не читает window/performance и ничего не отправляет — всё
 * нужное приходит аргументом. Это позволяет проверить сборку и обрезку тестами
 * и переиспользовать её в этапе 2 без изменений.
 *
 * При превышении MAX_BUNDLE_BYTES усечение идёт от самых старых записей:
 * сначала `net`, затем `b24`. Счётчики в `dropped` увеличиваются, чтобы при
 * разборе было видно, что часть данных отброшена, а не «ничего не происходило».
 */
export function buildBundle(input: BuildBundleInput): DiagBundle {
  const bundle: DiagBundle = {
    ...input,
    v: 1,
    net: input.net.map((entry) => ({
      ...entry,
      url: redactUrl(entry.url),
      headers: redactHeaders(entry.headers)
    })),
    dropped: { ...input.dropped }
  }

  while (byteLength(bundle) > MAX_BUNDLE_BYTES && bundle.net.length > 0) {
    bundle.net.shift()
    bundle.dropped.net += 1
  }
  while (byteLength(bundle) > MAX_BUNDLE_BYTES && bundle.b24.length > 0) {
    bundle.b24 = bundle.b24.slice(1)
  }

  return bundle
}
