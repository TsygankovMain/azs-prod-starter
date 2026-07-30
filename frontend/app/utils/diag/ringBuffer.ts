export type RingBuffer<T> = {
  push: (item: T) => void
  toArray: () => T[]
  readonly size: number
  readonly dropped: number
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(`createRingBuffer: capacity must be a positive integer, got ${String(capacity)}`)
  }
  const items: T[] = []
  let dropped = 0
  return {
    push(item: T): void {
      items.push(item)
      if (items.length > capacity) {
        items.shift()
        dropped += 1
      }
    },
    toArray: (): T[] => items.slice(),
    get size(): number { return items.length },
    get dropped(): number { return dropped }
  }
}
