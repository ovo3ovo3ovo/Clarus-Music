import { describe, expect, it, vi } from 'vitest'
import { CoalescedSettingsWriter } from './coalesced-settings-writer'

describe('CoalescedSettingsWriter', () => {
  it('coalesces rapid changes into the latest snapshot', async () => {
    vi.useFakeTimers()
    const saved: number[] = []
    const writer = new CoalescedSettingsWriter<number>({
      delayMs: 350,
      clone: (value) => value,
      save: async (value) => {
        saved.push(value)
      },
    })

    writer.schedule(1)
    writer.schedule(2)
    writer.schedule(3)
    await vi.advanceTimersByTimeAsync(350)

    expect(saved).toEqual([3])
    vi.useRealTimers()
  })

  it('serializes writes and persists the newest value queued in flight', async () => {
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const saved: number[] = []
    const writer = new CoalescedSettingsWriter<number>({
      clone: (value) => value,
      save: async (value) => {
        saved.push(value)
        if (value === 1) await firstWrite
      },
    })

    writer.schedule(1)
    const flushing = writer.flush()
    await Promise.resolve()
    writer.schedule(2)
    writer.schedule(3)
    releaseFirst?.()
    await flushing

    expect(saved).toEqual([1, 3])
  })

  it('flushes immediately without waiting for the debounce timer', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => undefined)
    const writer = new CoalescedSettingsWriter<number>({
      clone: (value) => value,
      save,
    })

    writer.schedule(7)
    await writer.flush()

    expect(save).toHaveBeenCalledWith(7)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('flushes on disposal and refuses later mutations', async () => {
    const save = vi.fn(async () => undefined)
    const writer = new CoalescedSettingsWriter<number>({
      clone: (value) => value,
      save,
    })

    writer.schedule(9)
    await writer.dispose()

    expect(save).toHaveBeenCalledWith(9)
    expect(() => writer.schedule(10)).toThrow('disposed')
  })
})
