export interface PlaybackFrame {
  readonly timestamp: number
  readonly currentTime: number
}

export type PlaybackFrameSubscriber = (frame: PlaybackFrame) => void

export interface PlaybackFrameScheduler {
  subscribe(subscriber: PlaybackFrameSubscriber): () => void
  setClock(readTime: (() => number) | null): () => void
  wake(): void
}

interface PlaybackFrameSchedulerOptions {
  readonly requestFrame?: (callback: FrameRequestCallback) => number
  readonly cancelFrame?: (id: number) => void
  readonly readTime?: () => number
  readonly isHidden?: () => boolean
}

function defaultRequestFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback)
  }
  return globalThis.setTimeout(
    () => callback(globalThis.performance?.now() ?? Date.now()),
    16,
  ) as unknown as number
}

function defaultCancelFrame(id: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(id)
  } else {
    globalThis.clearTimeout(id)
  }
}

export function createPlaybackFrameScheduler(
  options: PlaybackFrameSchedulerOptions = {},
): PlaybackFrameScheduler {
  const requestFrame = options.requestFrame ?? defaultRequestFrame
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame
  const isHidden = options.isHidden ?? (() => Boolean(globalThis.document?.hidden))
  const subscribers = new Set<PlaybackFrameSubscriber>()
  let readTime = options.readTime ?? null
  const clockLeases: Array<{
    readonly owner: object
    readonly readTime: (() => number) | null
    released: boolean
  }> = []
  let frameId: number | null = null

  const restoreLatestClock = (): void => {
    while (clockLeases.at(-1)?.released) clockLeases.pop()
    const latest = clockLeases.at(-1)
    readTime = latest === undefined ? (options.readTime ?? null) : latest.readTime
  }

  const schedule = (): void => {
    if (frameId !== null || subscribers.size === 0 || isHidden()) return
    frameId = requestFrame((timestamp) => {
      frameId = null
      if (subscribers.size === 0 || isHidden()) return
      const currentTime = readTime?.() ?? Number.NaN
      for (const subscriber of [...subscribers]) subscriber({ timestamp, currentTime })
      schedule()
    })
  }

  return {
    subscribe(subscriber) {
      subscribers.add(subscriber)
      schedule()
      return () => {
        if (!subscribers.delete(subscriber) || subscribers.size > 0) return
        if (frameId !== null) cancelFrame(frameId)
        frameId = null
      }
    },
    setClock(nextReadTime) {
      const owner = {}
      const lease = { owner, readTime: nextReadTime, released: false }
      clockLeases.push(lease)
      readTime = nextReadTime
      return () => {
        if (lease.released) return
        lease.released = true
        restoreLatestClock()
      }
    },
    wake() {
      schedule()
    },
  }
}

export const playbackFrameScheduler = createPlaybackFrameScheduler()
