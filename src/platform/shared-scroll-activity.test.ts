import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeScrollActivity } from './shared-scroll-activity'

afterEach(() => {
  vi.useRealTimers()
})

describe('shared scroll activity', () => {
  it('coalesces one root into active and settled notifications', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    const first: boolean[] = []
    const second: boolean[] = []
    const unsubscribeFirst = subscribeScrollActivity(root, (active) => first.push(active))
    const unsubscribeSecond = subscribeScrollActivity(root, (active) => second.push(active))

    root.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(100)
    root.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(179)
    expect(first).toEqual([false, true])
    expect(second).toEqual([false, true])
    vi.advanceTimersByTime(1)
    expect(first).toEqual([false, true, false])
    expect(second).toEqual([false, true, false])

    unsubscribeFirst()
    unsubscribeSecond()
  })
})
