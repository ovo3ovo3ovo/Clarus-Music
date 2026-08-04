import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackLyrics } from '../domain/lyrics'
import { availableLyricMode, createLyricsStore } from './lyrics-store'

const player = reactive({
  currentTrack: null as { id: number } | null,
  pendingTrack: null as { id: number } | null,
})

const translated: TrackLyrics = {
  instrumental: false,
  lines: [{ timeMs: 1_000, original: 'One', translation: 'Translation', romanization: null }],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

describe('lyrics store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    player.currentTrack = null
    player.pendingTrack = null
  })

  it('keeps the legacy lyric data loaded while the overlay is hidden', async () => {
    const request = deferred<TrackLyrics>()
    let signal: AbortSignal | undefined
    const gateway = {
      load: vi.fn((_: number, nextSignal?: AbortSignal) => {
        signal = nextSignal
        return request.promise
      }),
    }
    player.currentTrack = { id: 10 }
    const lyrics = createLyricsStore(gateway, 'lyricsVisibleTest', player)()

    await Promise.resolve()
    expect(gateway.load).toHaveBeenCalledWith(10, expect.any(AbortSignal))
    request.resolve(translated)
    await request.promise
    await Promise.resolve()

    lyrics.close()
    await Promise.resolve()
    expect(signal?.aborted).toBe(false)
    expect(lyrics.loading).toBe(false)
    expect(lyrics.lyrics).toBe(translated)
  })

  it('cancels a previous song and prevents its stale result from winning', async () => {
    const first = deferred<TrackLyrics>()
    const second = deferred<TrackLyrics>()
    const signals: AbortSignal[] = []
    const gateway = {
      load: vi.fn((trackId: number, signal?: AbortSignal) => {
        if (signal) signals.push(signal)
        return trackId === 1 ? first.promise : second.promise
      }),
    }
    player.currentTrack = { id: 1 }
    const lyrics = createLyricsStore(gateway, 'lyricsRaceTest', player)()
    lyrics.open()
    await Promise.resolve()

    player.currentTrack = { id: 2 }
    await Promise.resolve()
    expect(signals[0]?.aborted).toBe(true)
    second.resolve(translated)
    await second.promise
    await Promise.resolve()
    expect(lyrics.lyrics).toBe(translated)

    first.resolve({ instrumental: true, lines: [] })
    await first.promise
    await Promise.resolve()
    expect(lyrics.lyrics).toBe(translated)
  })

  it('loads lyrics for the selected next track before its audio has finished resolving', async () => {
    const pendingLyrics = deferred<TrackLyrics>()
    const gateway = {
      load: vi.fn((trackId: number) =>
        trackId === 2 ? pendingLyrics.promise : Promise.resolve({ instrumental: true, lines: [] }),
      ),
    }
    player.currentTrack = { id: 1 }
    const lyrics = createLyricsStore(gateway, 'lyricsPendingTrackTest', player)()

    await Promise.resolve()
    await Promise.resolve()
    player.pendingTrack = { id: 2 }
    await Promise.resolve()

    expect(gateway.load).toHaveBeenLastCalledWith(2, expect.any(AbortSignal))
    pendingLyrics.resolve(translated)
    await pendingLyrics.promise
    await Promise.resolve()

    expect(player.currentTrack?.id).toBe(1)
    expect(lyrics.lyrics).toBe(translated)
  })

  it('chooses a mode that is actually available', () => {
    const romanized: TrackLyrics = {
      instrumental: false,
      lines: [{ timeMs: 0, original: 'One', translation: null, romanization: 'One romanized' }],
    }
    expect(availableLyricMode(translated)).toBe('translation')
    expect(availableLyricMode(romanized)).toBe('romanization')
    expect(availableLyricMode(translated, 'romanization')).toBe('translation')
  })
})
