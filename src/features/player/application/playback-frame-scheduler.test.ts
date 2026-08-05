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
})
