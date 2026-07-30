export const SEND_THROTTLE_MS = 60_000
export const MAX_PENDING = 3

/**
 * Разрешать отправку не чаще одного раза в SEND_THROTTLE_MS.
 * Битая или отсутствующая метка времени трактуется как «раньше не отправляли»:
 * лучше отправить лишний бандл, чем потерять единственный.
 */
export function shouldSend(lastSentAtMs: number | null, nowMs: number): boolean {
  if (lastSentAtMs === null || !Number.isFinite(lastSentAtMs)) return true
  return nowMs - lastSentAtMs >= SEND_THROTTLE_MS
}

/** Оставить только последние maxItems элементов очереди ретрая. */
export function trimPendingQueue<T>(queue: T[], maxItems: number = MAX_PENDING): T[] {
  if (!Array.isArray(queue)) return []
  if (queue.length <= maxItems) return queue.slice()
  return queue.slice(queue.length - maxItems)
}
