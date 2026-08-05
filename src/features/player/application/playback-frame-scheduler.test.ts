import { describe, expect, it, vi } from 'vitest'
import { createPlaybackFrameScheduler } from './playback-frame-scheduler'

describe('playback frame scheduler', () => {
  it('samples the clock once and notifies subscribers in registration order', () => {
    let nextFrame: FrameRequestCallback | undefined
    let frameId = 0
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback
      frameId += 1
      return frameId
    })
    const cancelFrame = vi.fn()
    const readTime = vi.fn(() => 12.5)
    const scheduler = createPlaybackFrameScheduler({ requestFrame, cancelFrame, readTime })
    const events: string[] = []

    scheduler.subscribe(({ currentTime, timestamp }) => {
      events.push(`progress:${currentTime}:${timestamp}`)
    })
    scheduler.subscribe(({ currentTime, timestamp }) => {
      events.push(`lyrics:${currentTime}:${timestamp}`)
    })

    expect(requestFrame).toHaveBeenCalledOnce()
    nextFrame?.(100)

    expect(readTime).toHaveBeenCalledOnce()
    expect(events).toEqual(['progress:12.5:100', 'lyrics:12.5:100'])
    expect(requestFrame).toHaveBeenCalledTimes(2)
  })

  it('stops scheduling after the last subscriber leaves', () => {
    let nextFrame: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback
      return 1
    })
    const cancelFrame = vi.fn()
    const scheduler = createPlaybackFrameScheduler({ requestFrame, cancelFrame })
    const unsubscribe = scheduler.subscribe(() => undefined)

    unsubscribe()
    expect(cancelFrame).toHaveBeenCalledOnce()
    nextFrame?.(100)
    expect(requestFrame).toHaveBeenCalledOnce()
  })

  it('does not invoke subscribers while hidden and resumes when visible', () => {
    let hidden = false
    let nextFrame: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback
      return requestFrame.mock.calls.length
    })
    const cancelFrame = vi.fn()
    const listener = vi.fn()
    const scheduler = createPlaybackFrameScheduler({
      requestFrame,
      cancelFrame,
      isHidden: () => hidden,
    })
    scheduler.subscribe(listener)

    hidden = true
    nextFrame?.(100)
    expect(listener).not.toHaveBeenCalled()

    hidden = false
    scheduler.wake()
    nextFrame?.(200)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ currentTime: Number.NaN, timestamp: 200 })
  })

  it('does not let an older clock release a newer clock', () => {
    let nextFrame: FrameRequestCallback | undefined
    const scheduler = createPlaybackFrameScheduler({
      requestFrame: (callback) => {
        nextFrame = callback
        return 1
      },
      readTime: () => 1,
    })
    const listener = vi.fn()
    scheduler.subscribe(listener)

    const releaseFirst = scheduler.setClock(() => 10)
    const releaseSecond = scheduler.setClock(() => 20)
    releaseFirst()
    nextFrame?.(100)

    expect(listener).toHaveBeenCalledWith({ currentTime: 20, timestamp: 100 })
    releaseSecond()
  })

  it('restores the previous active clock when the newest owner leaves', () => {
    let nextFrame: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback
      return requestFrame.mock.calls.length
    })
    const scheduler = createPlaybackFrameScheduler({ requestFrame })
    const listener = vi.fn()
    scheduler.subscribe(listener)

    const releaseFirst = scheduler.setClock(() => 10)
    const releaseSecond = scheduler.setClock(() => 20)
    releaseSecond()
    nextFrame?.(100)

    expect(listener).toHaveBeenCalledWith({ currentTime: 10, timestamp: 100 })
    releaseFirst()
  })

  it('preserves an explicitly empty clock lease', () => {
    let nextFrame: FrameRequestCallback | undefined
    const scheduler = createPlaybackFrameScheduler({
      requestFrame: (callback) => {
        nextFrame = callback
        return 1
      },
      readTime: () => 5,
    })
    const listener = vi.fn()
    scheduler.subscribe(listener)

    const releaseClock = scheduler.setClock(null)
    nextFrame?.(100)

    expect(listener).toHaveBeenCalledWith({ currentTime: Number.NaN, timestamp: 100 })
    releaseClock()
  })

  it('keeps independent subscriber clocks isolated while sampling each once', () => {
    let nextFrame: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback
      return requestFrame.mock.calls.length
    })
    const cancelFrame = vi.fn()
    const scheduler = createPlaybackFrameScheduler({ requestFrame, cancelFrame })
    const firstClock = vi.fn(() => 10)
    const secondClock = vi.fn(() => 20)
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    scheduler.subscribe(firstListener, firstClock)
    scheduler.subscribe(secondListener, secondClock)

    nextFrame?.(100)

    expect(firstClock).toHaveBeenCalledOnce()
    expect(secondClock).toHaveBeenCalledOnce()
    expect(firstListener).toHaveBeenCalledWith({ currentTime: 10, timestamp: 100 })
    expect(secondListener).toHaveBeenCalledWith({ currentTime: 20, timestamp: 100 })
  })

  it('shares one clock sample between subscribers bound to the same owner', () => {
    let nextFrame: FrameRequestCallback | undefined
    const scheduler = createPlaybackFrameScheduler({
      requestFrame: (callback) => {
        nextFrame = callback
        return 1
      },
    })
    const clock = vi.fn(() => 42)
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    scheduler.subscribe(firstListener, clock)
    scheduler.subscribe(secondListener, clock)

    nextFrame?.(100)

    expect(clock).toHaveBeenCalledOnce()
    expect(firstListener).toHaveBeenCalledWith({ currentTime: 42, timestamp: 100 })
    expect(secondListener).toHaveBeenCalledWith({ currentTime: 42, timestamp: 100 })
  })
})
