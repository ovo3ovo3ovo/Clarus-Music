export type PlaybackFrameSubscriber = (timestamp: number, currentTime: number) => void

export interface PlaybackFrameScheduler {
  subscribe(subscriber: PlaybackFrameSubscriber, readTime?: (() => number) | null): () => void
  setClock(readTime: (() => number) | null): () => void
  wake(): void
}

interface PlaybackFrameSchedulerOptions {
  readonly requestFrame?: (callback: FrameRequestCallback) => number
  readonly cancelFrame?: (id: number) => void
  readonly readTime?: () => number
  readonly isHidden?: () => boolean
}

type PlaybackClock = (() => number) | null

interface ClockEntry {
  clock: PlaybackClock
  references: number
  currentTime: number
}

interface Subscription {
  readonly subscriber: PlaybackFrameSubscriber
  readonly clock: ClockEntry
  previous: Subscription | null
  next: Subscription | null
  active: boolean
}

function defaultRequestFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback)
  }
  // Timers do not provide rAF's timestamp, but they can invoke the same
  // callback directly. `handleFrame` supplies a timestamp in that fallback
  // path, avoiding a wrapper closure for every timer frame.
  return globalThis.setTimeout(callback as unknown as () => void, 16) as unknown as number
}

function defaultCancelFrame(id: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(id)
  } else {
    globalThis.clearTimeout(id)
  }
}

/**
 * Fan out one display clock without making display-rate garbage.  A frame is
 * represented by primitive arguments, clock samples live in persistent
 * entries, and subscriptions are an intrusive list.  That keeps a 120 Hz
 * playback clock from allocating a Map, array, closure, or frame object on
 * every callback.
 */
export function createPlaybackFrameScheduler(
  options: PlaybackFrameSchedulerOptions = {},
): PlaybackFrameScheduler {
  const requestFrame = options.requestFrame ?? defaultRequestFrame
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame
  const isHidden = options.isHidden ?? (() => Boolean(globalThis.document?.hidden))
  const fallbackClock = options.readTime ?? null
  const defaultClock: ClockEntry = {
    clock: fallbackClock,
    references: 0,
    currentTime: Number.NaN,
  }
  // Index zero is reserved for default-clock subscribers.  Explicit clocks
  // are retained only while they have at least one subscriber.
  const clockEntries: ClockEntry[] = [defaultClock]
  const clockLeases: Array<{ readonly readTime: PlaybackClock }> = []
  let firstSubscription: Subscription | null = null
  let lastSubscription: Subscription | null = null
  let frameId: number | null = null

  const setReadTime = (nextReadTime: PlaybackClock): void => {
    defaultClock.clock = nextReadTime
  }

  const restoreLatestClock = (): void => {
    const latest = clockLeases.at(-1)
    setReadTime(latest === undefined ? fallbackClock : latest.readTime)
  }

  const retainClock = (clock: PlaybackClock | undefined): ClockEntry => {
    if (clock === undefined) {
      defaultClock.references += 1
      return defaultClock
    }
    let index = 1
    while (index < clockEntries.length) {
      const entry = clockEntries[index]!
      if (entry.clock === clock) {
        entry.references += 1
        return entry
      }
      index += 1
    }
    const entry: ClockEntry = { clock, references: 1, currentTime: Number.NaN }
    clockEntries.push(entry)
    return entry
  }

  const releaseClock = (entry: ClockEntry): void => {
    entry.references -= 1
    if (entry === defaultClock || entry.references > 0) return
    const index = clockEntries.indexOf(entry)
    if (index > 0) clockEntries.splice(index, 1)
  }

  const schedule = (): void => {
    if (frameId !== null || firstSubscription === null || isHidden()) return
    frameId = requestFrame(handleFrame)
  }

  const handleFrame: FrameRequestCallback = (timestamp) => {
    frameId = null
    if (firstSubscription === null || isHidden()) return
    const frameTimestamp = Number.isFinite(timestamp)
      ? timestamp
      : (globalThis.performance?.now() ?? Date.now())

    let clockIndex = 0
    while (clockIndex < clockEntries.length) {
      const entry = clockEntries[clockIndex]!
      if (entry.references > 0) {
        entry.currentTime = entry.clock === null ? Number.NaN : entry.clock()
      }
      clockIndex += 1
    }

    // Preserve the old registration-snapshot behavior: a component that
    // mounts while a frame is being dispatched starts on the next display
    // frame. Capturing a tail node costs no allocation and still lets current
    // subscribers remove themselves safely.
    const frameTail = lastSubscription
    let subscription: Subscription | null = firstSubscription
    while (subscription !== null) {
      const nextSubscription: Subscription | null = subscription.next
      if (subscription.active) {
        subscription.subscriber(frameTimestamp, subscription.clock.currentTime)
      }
      if (subscription === frameTail) break
      subscription = nextSubscription
    }
    schedule()
  }

  return {
    subscribe(subscriber, subscriberClock) {
      const clock = retainClock(subscriberClock)
      const subscription: Subscription = {
        subscriber,
        clock,
        previous: lastSubscription,
        next: null,
        active: true,
      }
      if (lastSubscription === null) firstSubscription = subscription
      else lastSubscription.next = subscription
      lastSubscription = subscription
      schedule()

      return () => {
        if (!subscription.active) return
        subscription.active = false
        const previous = subscription.previous
        const next = subscription.next
        if (previous === null) firstSubscription = next
        else previous.next = next
        if (next === null) lastSubscription = previous
        else next.previous = previous
        releaseClock(clock)
        if (firstSubscription !== null || frameId === null) return
        cancelFrame(frameId)
        frameId = null
      }
    },
    setClock(nextReadTime) {
      const lease = { readTime: nextReadTime }
      clockLeases.push(lease)
      setReadTime(nextReadTime)
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
