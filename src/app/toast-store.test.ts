import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createToastStore } from './toast-store'

describe('toast store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces the previous timer before hiding the latest message', () => {
    const toast = createToastStore('toast-replacement')()

    toast.show('First', 1000)
    vi.advanceTimersByTime(500)
    toast.show('Second', 1000)
    vi.advanceTimersByTime(500)

    expect(toast.visible).toBe(true)
    expect(toast.message).toBe('Second')

    vi.advanceTimersByTime(500)
    expect(toast.visible).toBe(false)
    expect(toast.message).toBeNull()
  })

  it('supports persistent messages and clears state on disposal', () => {
    const toast = createToastStore('toast-disposal')()

    toast.show('Persistent', 0)
    vi.runAllTimers()
    expect(toast.message).toBe('Persistent')

    toast.dispose()
    expect(toast.visible).toBe(false)
    expect(toast.message).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores empty messages without replacing the active toast', () => {
    const toast = createToastStore('toast-empty')()

    toast.show('Visible', 1000)
    toast.show('   ')

    expect(toast.message).toBe('Visible')
    expect(vi.getTimerCount()).toBe(1)
  })
})
