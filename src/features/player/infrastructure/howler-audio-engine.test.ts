import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  howls: [] as Array<{
    options: Record<string, unknown>
    unload: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('howler', () => ({
  Howl: class {
    readonly options: Record<string, unknown>
    readonly unload = vi.fn()
    private readonly eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
    private currentVolume = 1
    private currentPosition = 0

    constructor(options: Record<string, unknown>) {
      this.options = options
      mocks.howls.push(this)
      queueMicrotask(() => (options.onload as (() => void) | undefined)?.())
    }

    duration(): number {
      return 180
    }

    volume(value?: number): number | void {
      if (value === undefined) return this.currentVolume
      this.currentVolume = value
    }

    seek(value?: number): number | void {
      if (value === undefined) return this.currentPosition
      this.currentPosition = value
    }

    playing(): boolean {
      return false
    }

    play(): number {
      queueMicrotask(() => (this.options.onplay as (() => void) | undefined)?.())
      return 1
    }

    pause(): void {}

    on(event: string, listener: (...args: unknown[]) => void): void {
      const listeners = this.eventListeners.get(event) ?? new Set()
      listeners.add(listener)
      this.eventListeners.set(event, listeners)
    }

    off(event: string, listener?: (...args: unknown[]) => void): void {
      if (!listener) {
        this.eventListeners.delete(event)
        return
      }
      this.eventListeners.get(event)?.delete(listener)
    }

    once(event: string, listener: (...args: unknown[]) => void): void {
      this.on(event, listener)
    }
  },
}))

import { HowlerAudioEngine, audioFormatForSource } from './howler-audio-engine'

describe('Howler source format selection', () => {
  it.each([
    ['audio/flac', 'flac'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg', 'ogg'],
    ['audio/webm', 'webm'],
    ['audio/mpeg', 'mp3'],
  ])('preserves the media format for managed URLs (%s)', (mimeType, expected) => {
    expect(
      audioFormatForSource({
        kind: 'managed-url',
        url: 'asset://localhost/cache/song',
        mimeType,
        release: () => {},
      }),
    ).toBe(expected)
  })

  it.each([
    ['audio/flac', 'flac'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg', 'ogg'],
    ['audio/webm', 'webm'],
    ['audio/mpeg', 'mp3'],
  ])(
    'passes the managed MIME format through an actual engine load (%s)',
    async (mimeType, expected) => {
      mocks.howls.length = 0
      const engine = new HowlerAudioEngine()
      await engine.load({
        kind: 'managed-url',
        url: `asset://localhost/cache/song.${expected}`,
        mimeType,
        release: vi.fn(),
      })

      expect(mocks.howls.at(-1)?.options.format).toEqual([expected])
      engine.dispose()
    },
  )
})
