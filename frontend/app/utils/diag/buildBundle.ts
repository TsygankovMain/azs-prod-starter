import { redactHeaders, redactUrl, redactText } from './redact.ts'
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
 * сначала `net`, затем `b24`, `uploads`, `errors`. Счётчики в `dropped` увеличиваются,
 * чтобы при разборе было видно, что часть данных отброшена, а не «ничего не происходило».
 */
export function buildBundle(input: BuildBundleInput): DiagBundle {
  const bundle: DiagBundle = {
    ...input,
    v: 1,
    net: (input.net ?? []).map((entry) => ({
      ...entry,
      url: redactUrl(entry.url),
      headers: redactHeaders(entry.headers)
    })),
    errors: (input.errors ?? []).map((entry) => ({
      ...entry,
      message: redactText(entry.message),
      stack: entry.stack === undefined ? undefined : redactText(entry.stack)
    })),
    uploads: (input.uploads ?? []).map((entry) => ({ ...entry, message: redactText(entry.message) })),
    queue: {
      ...input.queue,
      slots: (input.queue?.slots ?? []).map((slot) => ({ ...slot, error: redactText(slot.error) }))
    },
    dropped: { ...input.dropped }
  }

  // Порядок усечения — от наименее ценного к наиболее ценному. Тексты ошибок
  // сбрасываем последними: по B2 у нас до сих пор нет ни одного текста ошибки,
  // это самая дефицитная часть бандла. Функция возвращает false, когда сбрасывать
  // больше нечего, — цикл гарантированно завершается.
  const shedOldest = (): boolean => {
    if ((bundle.net?.length ?? 0) > 0) { bundle.net.shift(); bundle.dropped.net += 1; return true }
    if ((bundle.b24?.length ?? 0) > 0) { bundle.b24 = bundle.b24.slice(1); return true }
    if ((bundle.uploads?.length ?? 0) > 0) { bundle.uploads = bundle.uploads.slice(1); bundle.dropped.uploads += 1; return true }
    if ((bundle.errors?.length ?? 0) > 0) { bundle.errors = bundle.errors.slice(1); bundle.dropped.errors += 1; return true }
    return false
  }
  while (byteLength(bundle) > MAX_BUNDLE_BYTES && shedOldest()) { /* усекаем, пока не поместится */ }

  return bundle
}
