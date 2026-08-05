export interface PlaybackFrame {
  readonly timestamp: number
  readonly currentTime: number
}

export type PlaybackFrameSubscriber = (frame: PlaybackFrame) => void

export interface PlaybackFrameScheduler {
  subscribe(
    subscriber: PlaybackFrameSubscriber,
    readTime?: (() => number) | null,
  ): () => void
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
  const subscribers = new Map<
    PlaybackFrameSubscriber,
    (() => number) | null | undefined
  >()
  let readTime = options.readTime ?? null
  const clockLeases: Array<{
    readonly readTime: (() => number) | null
  }> = []
  let frameId: number | null = null

  const restoreLatestClock = (): void => {
    const latest = clockLeases.at(-1)
    readTime = latest === undefined ? (options.readTime ?? null) : latest.readTime
  }

  const schedule = (): void => {
    if (frameId !== null || subscribers.size === 0 || isHidden()) return
    frameId = requestFrame((timestamp) => {
      frameId = null
      if (subscribers.size === 0 || isHidden()) return
      const sampledTimes = new Map<(() => number) | null, number>()
      const sample = (clock: (() => number) | null): number => {
        if (clock === null) return Number.NaN
        const existing = sampledTimes.get(clock)
        if (existing !== undefined) return existing
        const currentTime = clock()
        sampledTimes.set(clock, currentTime)
        return currentTime
      }
      for (const [subscriber, subscriberClock] of [...subscribers]) {
        const clock = subscriberClock === undefined ? readTime : subscriberClock
        subscriber({ timestamp, currentTime: sample(clock) })
      }
      schedule()
    })
  }

  return {
    subscribe(subscriber, subscriberClock) {
      subscribers.set(subscriber, subscriberClock)
      schedule()
      return () => {
        if (!subscribers.delete(subscriber) || subscribers.size > 0) return
        if (frameId !== null) cancelFrame(frameId)
        frameId = null
      }
    },
    setClock(nextReadTime) {
      const lease = { readTime: nextReadTime }
      clockLeases.push(lease)
      readTime = nextReadTime
      let released = false
      return () => {
        if (released) return
        released = true
        const index = clockLeases.indexOf(lease)
        if (index < 0) return
        const wasLatest = index === clockLeases.length - 1
        clockLeases.splice(index, 1)
        if (wasLatest) restoreLatestClock()
      }
    },
    wake() {
      schedule()
    },
  }
}

export const playbackFrameScheduler = createPlaybackFrameScheduler()
