import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AudioEngine,
  AudioEngineEventMap,
  AudioEngineListener,
  AudioEngineState,
  AudioSource,
} from '../domain/audio-engine'
import type {
  MediaSessionTransport,
  PlayerMediaSession,
} from '../infrastructure/browser-media-session'
import type { Track } from '@/types/music'
import { nativeTrackLikeGateway, type TrackLikeGateway } from '../infrastructure/native-like'
import {
  PLAYER_QUEUE_SNAPSHOT_VERSION,
  type PlayerQueuePersistence,
  type PlayerQueueSnapshot,
} from '../infrastructure/queue-snapshot'
import { configurePlayerRuntime, createPlayerStore, usePlayerStore } from './player-store'
import { playbackFrameScheduler } from './playback-frame-scheduler'

const settingsMock = vi.hoisted(() => ({
  settings: {
    musicQuality: '320000',
    outputDevice: 'default',
  },
}))

vi.mock('@/features/settings/application/settings-store', () => ({
  useSettingsStore: () => settingsMock,
}))

function track(id: number): Track {
  return {
    id,
    name: `Track ${id}`,
    durationMs: 180_000,
    artists: [{ id: id + 100, name: 'Artist' }],
    album: { id: id + 200, name: 'Album', coverUrl: 'https://img.test/cover.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  }
}

class FakeEngine implements AudioEngine {
  state: AudioEngineState = 'ready'
  currentTime = 0
  duration = 180
  volume = 1
  supportsOutputDeviceSelection = false
  readonly load: AudioEngine['load'] = vi.fn(async () => undefined)
  readonly play = vi.fn(async () => undefined)
  readonly pause = vi.fn()
  readonly seek = vi.fn((seconds: number) => {
    this.currentTime = Math.min(Math.max(seconds, 0), this.duration)
  })
  readonly setVolume = vi.fn((value: number) => {
    this.volume = value
  })
  readonly setOutputDevice = vi.fn(async () => undefined)
  readonly dispose = vi.fn()
  private readonly listeners = new Map<keyof AudioEngineEventMap, Set<(value: never) => void>>()

  subscribe<K extends keyof AudioEngineEventMap>(
    event: K,
    listener: AudioEngineListener<K>,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener as (value: never) => void)
    this.listeners.set(event, listeners)
    return () => listeners.delete(listener as (value: never) => void)
  }

  emit<K extends keyof AudioEngineEventMap>(event: K, value: AudioEngineEventMap[K]): void {
    if (event === 'state') this.state = value as AudioEngineState
    for (const listener of this.listeners.get(event) ?? []) listener(value as never)
  }
}

class FakeMediaSession implements PlayerMediaSession {
  transport: MediaSessionTransport | null = null
  readonly tracks: (Track | null)[] = []
  readonly playbackStates: AudioEngineState[] = []
  readonly positions: Readonly<{ duration: number; position: number }>[] = []
  disposed = false

  setTrack(value: Track | null): void {
    this.tracks.push(value)
  }

  setPlaybackState(value: AudioEngineState): void {
    this.playbackStates.push(value)
  }

  setPositionState(duration: number, position: number): void {
    this.positions.push({ duration, position })
  }

  dispose(): void {
    this.disposed = true
  }
}

describe('player queue navigation', () => {
  let storeId = 0

  beforeEach(() => {
    setActivePinia(createPinia())
    storeId += 1
  })

  function setup(
    resolveStream: (
      id: number,
      quality: string,
      signal?: AbortSignal,
    ) => Promise<AudioSource> = vi.fn(
      async (id: number) => ({ kind: 'remote', url: `https://a/${id}` }) as AudioSource,
    ),
    likeGateway: TrackLikeGateway = {
      check: vi.fn(async () => false),
      setLiked: vi.fn(async (_id: number, liked: boolean) => liked),
    },
    queuePersistence?: PlayerQueuePersistence,
  ) {
    const engine = new FakeEngine()
    const mediaSession = new FakeMediaSession()
    const useStore = createPlayerStore(
      () => engine,
      { resolveStream },
      () => 0,
      `player-${storeId}`,
      (transport) => {
        mediaSession.transport = transport
        return mediaSession
      },
      likeGateway,
      queuePersistence,
    )
    return { engine, mediaSession, resolveStream, likeGateway, player: useStore() }
  }

  it('loads and toggles the current track like state explicitly', async () => {
    const likeGateway: TrackLikeGateway = {
      check: vi.fn(async () => true),
      setLiked: vi.fn(async (_id, liked) => liked),
    }
    const { player } = setup(undefined, likeGateway)
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)

    await vi.waitFor(() => expect(player.liked).toBe(true))
    await expect(player.toggleLike()).resolves.toBe(false)
    expect(likeGateway.check).toHaveBeenCalledWith(1, expect.any(AbortSignal))
    expect(likeGateway.setLiked).toHaveBeenCalledWith(1, false, expect.any(AbortSignal))
    expect(player.liked).toBe(false)

    await expect(player.toggleLike()).resolves.toBe(true)
    expect(likeGateway.check).toHaveBeenCalledTimes(1)
    expect(player.liked).toBe(true)
  })

  it('resets like state when the current track changes', async () => {
    const likeGateway: TrackLikeGateway = {
      check: vi.fn(async () => false),
      setLiked: vi.fn(async (_id, liked) => liked),
    }
    const { player } = setup(undefined, likeGateway)
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    await player.toggleLike()
    expect(player.liked).toBe(true)

    await player.load(track(2), { kind: 'remote', url: 'https://a/2' }, false)
    await vi.waitFor(() => expect(player.liked).toBe(false))
  })

  it('keeps a confirmed external like mutation over an older status check', async () => {
    let resolveCheck: ((value: boolean) => void) | undefined
    const likeGateway: TrackLikeGateway = {
      check: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveCheck = resolve
          }),
      ),
      setLiked: vi.fn(async (_id, liked) => liked),
    }
    const { player } = setup(undefined, likeGateway)
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)

    player.syncLikeState(1, true)
    resolveCheck?.(false)

    await vi.waitFor(() => expect(player.likeBusy).toBe(false))
    expect(player.liked).toBe(true)
  })

  it('resolves and loads standard next and previous tracks before committing position', async () => {
    const { player, resolveStream } = setup()
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2), track(3)], 0, 'album:1')

    await expect(player.next()).resolves.toBe(true)
    expect(resolveStream).toHaveBeenCalledWith(2, '320000', expect.any(AbortSignal))
    expect(player.currentIndex).toBe(1)
    expect(player.currentTrack?.id).toBe(2)

    await expect(player.previous()).resolves.toBe(true)
    expect(player.currentIndex).toBe(0)
    expect(player.currentTrack?.id).toBe(1)
  })

  it('keeps a play-next item until its source and audio load succeed', async () => {
    let release: ((source: AudioSource) => void) | undefined
    const resolveStream = vi.fn(
      () =>
        new Promise<AudioSource>((resolve) => {
          release = resolve
        }),
    )
    const { player } = setup(resolveStream)
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2)], 0)
    player.addPlayNext(track(9))

    const pending = player.next()
    expect(player.playNextQueue.map(({ id }) => id)).toEqual([9])
    expect(player.pendingTrack?.id).toBe(9)
    release?.({ kind: 'remote', url: 'https://a/9' })
    await expect(pending).resolves.toBe(true)

    expect(player.playNextQueue).toEqual([])
    expect(player.currentTrack?.id).toBe(9)
    expect(player.pendingTrack).toBeNull()
    expect(player.currentIndex).toBe(0)
  })

  it('advances on natural end and repeats one without another network request', async () => {
    const { engine, player, resolveStream } = setup()
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2)], 0)

    engine.emit('state', 'ended')
    await vi.waitFor(() => expect(player.currentTrack?.id).toBe(2))

    player.cycleRepeatMode()
    player.cycleRepeatMode()
    vi.mocked(resolveStream).mockClear()
    engine.emit('state', 'ended')
    await vi.waitFor(() => expect(engine.seek).toHaveBeenCalledWith(0))
    expect(resolveStream).not.toHaveBeenCalled()
  })

  it('keeps one shuffled index order while advancing through it', async () => {
    const { player } = setup()
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2), track(3), track(4)], 0)
    player.toggleShuffle()

    await player.next()
    expect(player.currentTrack?.id).toBe(3)
    await player.next()
    expect(player.currentTrack?.id).toBe(4)
  })

  it('appends to shuffle without changing the existing future order', async () => {
    const { player } = setup()
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2), track(3), track(4)], 0, 'playlist:1')
    player.toggleShuffle()

    expect(player.upcomingTracks.map(({ id }) => id)).toEqual([3, 4, 2])
    expect(player.appendQueue([track(5), track(6)], 'playlist:1')).toBe(true)
    expect(player.upcomingTracks.map(({ id }) => id)).toEqual([3, 4, 2, 6, 5])
  })

  it('loads the next continuation page when playback reaches the known queue edge', async () => {
    const continuation = {
      loadNext: vi.fn(async () => ({ tracks: [track(2)], hasMore: false })),
    }
    const { player } = setup()
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1)], 0, 'playlist:edge')
    expect(player.setQueueContinuation('playlist:edge', continuation)).toBe(true)

    await expect(player.next()).resolves.toBe(true)
    expect(continuation.loadNext).toHaveBeenCalledOnce()
    expect(player.queue.map(({ id }) => id)).toEqual([1, 2])
    expect(player.currentTrack?.id).toBe(2)
  })

  it('does not request a continuation until the ahead window becomes small', async () => {
    vi.useFakeTimers()
    const continuation = {
      loadNext: vi.fn(async () => ({ tracks: [track(14), track(15)], hasMore: false })),
    }
    try {
      const { player } = setup()
      const knownTracks = Array.from({ length: 13 }, (_, index) => track(index + 1))
      await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
      player.setQueue(knownTracks, 0, 'playlist:window')
      player.setQueueContinuation('playlist:window', continuation)
      await vi.advanceTimersByTimeAsync(0)
      expect(continuation.loadNext).not.toHaveBeenCalled()

      await expect(player.next()).resolves.toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(continuation.loadNext).toHaveBeenCalledOnce()
      expect(player.queue.map(({ id }) => id)).toEqual(
        Array.from({ length: 15 }, (_, index) => index + 1),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('reverses the existing shuffle without drawing another order', async () => {
    const { player } = setup()
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2), track(3), track(4)], 0)
    player.toggleShuffle()
    expect(player.upcomingTracks.map(({ id }) => id)).toEqual([3, 4, 2])

    player.toggleReversed()
    expect(player.upcomingTracks.map(({ id }) => id)).toEqual([2, 4, 3])
    player.toggleReversed()
    expect(player.upcomingTracks.map(({ id }) => id)).toEqual([3, 4, 2])
  })

  it('keeps play-next mutations stable while a selected item is loading', async () => {
    let release: ((source: AudioSource) => void) | undefined
    const { player } = setup(
      vi.fn(
        () =>
          new Promise<AudioSource>((resolve) => {
            release = resolve
          }),
      ),
    )
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2)], 0)
    player.addPlayNext(track(9))
    player.addPlayNext(track(9))

    const pending = player.playPlayNextAt(1)
    expect(player.removePlayNextAt(0)).toBe(false)
    player.clearPlayNext()
    expect(player.playNextQueue).toHaveLength(2)
    release?.({ kind: 'remote', url: 'https://a/9' })
    await expect(pending).resolves.toBe(true)
    expect(player.playNextQueue).toHaveLength(1)
  })

  it('cancels superseded source resolution and commits only the latest navigation', async () => {
    let call = 0
    const resolveStream = vi.fn((id: number, _quality: string, signal?: AbortSignal) => {
      call += 1
      if (call > 1)
        return Promise.resolve({ kind: 'remote', url: `https://a/${id}` } as AudioSource)
      return new Promise<AudioSource>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('superseded', 'AbortError')),
          { once: true },
        )
      })
    })
    const { player } = setup(resolveStream)
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2)], 0)

    const first = player.next()
    const second = player.next()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(player.currentTrack?.id).toBe(2)
  })

  it('releases a managed source resolved after its navigation was superseded', async () => {
    let call = 0
    let resolveFirst: ((source: AudioSource) => void) | undefined
    const release = vi.fn()
    const resolveStream = vi.fn((id: number) => {
      call += 1
      if (call === 1) {
        return new Promise<AudioSource>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({ kind: 'remote', url: `https://a/${id}` } as AudioSource)
    })
    const { player } = setup(resolveStream)
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2)], 0)

    const first = player.next()
    resolveFirst?.({
      kind: 'managed-url',
      url: 'asset://localhost/song.mp3',
      mimeType: 'audio/mpeg',
      release,
    })
    const second = player.next()

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })

  it('lets a direct page selection cancel an older queue navigation', async () => {
    const resolveStream = vi.fn(
      (_id: number, _quality: string, signal?: AbortSignal) =>
        new Promise<AudioSource>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('direct selection', 'AbortError')),
            { once: true },
          )
        }),
    )
    const { player } = setup(resolveStream)
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.setQueue([track(1), track(2)], 0)

    const pendingNext = player.next()
    await player.load(track(8), { kind: 'remote', url: 'https://a/8' }, false)

    await expect(pendingNext).resolves.toBe(false)
    expect(player.currentTrack?.id).toBe(8)
    expect(player.currentIndex).toBe(0)
  })

  it('synchronizes track, playback, position, seek, and disposal with Media Session', async () => {
    const { engine, mediaSession, player } = setup()

    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    expect(mediaSession.tracks.at(-1)?.id).toBe(1)
    expect(mediaSession.playbackStates.at(-1)).toBe('ready')
    expect(mediaSession.positions.at(-1)).toEqual({ duration: 180, position: 0 })

    engine.currentTime = 12
    engine.emit('state', 'playing')
    expect(mediaSession.playbackStates.at(-1)).toBe('playing')
    expect(mediaSession.positions.at(-1)).toEqual({ duration: 180, position: 12 })

    engine.duration = 200
    engine.emit('duration', 200)
    engine.currentTime = 45
    engine.emit('time', 45)
    expect(mediaSession.positions.at(-1)).toEqual({ duration: 200, position: 45 })

    player.seek(500)
    expect(mediaSession.positions.at(-1)).toEqual({ duration: 200, position: 200 })
    expect(player.progress).toBe(200)

    player.dispose()
    expect(mediaSession.disposed).toBe(true)
  })

  it('resets a legacy reversed queue while restoring without resolving audio', async () => {
    const restored: PlayerQueueSnapshot = {
      version: PLAYER_QUEUE_SNAPSHOT_VERSION,
      queue: [track(1), track(2)],
      playNextQueue: [track(9)],
      currentTrack: track(2),
      currentIndex: 1,
      currentIsPlayNext: false,
      queueSource: 'album:201',
      playbackOrder: [],
      repeatMode: 'all',
      shuffle: false,
      reversed: true,
      volume: 0.4,
      progress: 36,
    }
    const persistence: PlayerQueuePersistence = {
      load: vi.fn(() => restored),
      save: vi.fn(),
      clear: vi.fn(),
    }
    const { engine, mediaSession, player, resolveStream } = setup(undefined, undefined, persistence)

    expect(player.queue.map(({ id }) => id)).toEqual([1, 2])
    expect(player.playNextQueue.map(({ id }) => id)).toEqual([9])
    expect(player.currentTrack?.id).toBe(2)
    expect(player.currentIndex).toBe(1)
    expect(player.repeatMode).toBe('all')
    expect(player.reversed).toBe(false)
    expect(player.volume).toBe(0.4)
    expect(engine.load).not.toHaveBeenCalled()
    expect(mediaSession.tracks.at(-1)?.id).toBe(2)

    await player.togglePlayback()
    expect(resolveStream).toHaveBeenCalledWith(2, '320000', expect.any(AbortSignal))
    expect(engine.load).toHaveBeenCalled()
    expect(engine.seek).toHaveBeenCalledWith(36)
    expect(engine.play).toHaveBeenCalled()
  })

  it('persists the latest bounded queue when the player is disposed', async () => {
    const persistence: PlayerQueuePersistence = {
      load: vi.fn(() => null),
      save: vi.fn(),
      clear: vi.fn(),
    }
    const { engine, player } = setup(undefined, undefined, persistence)
    player.setQueue([track(1), track(2)], 0, 'playlist:7')
    await player.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    player.addPlayNext(track(9))
    player.cycleRepeatMode()
    engine.currentTime = 12
    engine.emit('time', 12)
    engine.emit('volume', 0.6)
    player.dispose()

    expect(persistence.save).toHaveBeenCalledWith(
      expect.objectContaining({
        version: PLAYER_QUEUE_SNAPSHOT_VERSION,
        currentIndex: 0,
        queueSource: 'playlist:7',
        repeatMode: 'all',
        volume: 0.6,
        progress: 12,
      }),
    )
  })

  it('keeps reactive progress on media events while exposing one stable visual clock', () => {
    const setClock = vi.spyOn(playbackFrameScheduler, 'setClock')
    const subscribe = vi.spyOn(playbackFrameScheduler, 'subscribe')
    const { engine, player } = setup()

    engine.emit('state', 'playing')

    const leaseClock = setClock.mock.calls.at(-1)?.[0]
    expect(leaseClock).toBeDefined()
    expect(leaseClock).toBe(player.playbackClock.read)
    expect(subscribe).not.toHaveBeenCalled()

    engine.currentTime = 12
    engine.emit('time', 12)
    expect(player.progress).toBe(12)

    engine.currentTime = 24
    expect(player.readCurrentTime()).toBe(24)
    expect(player.progress).toBe(12)

    engine.emit('seeked', 24)
    expect(player.progress).toBe(24)

    player.dispose()
    setClock.mockRestore()
    subscribe.mockRestore()
  })
})

describe('shared player runtime', () => {
  function memoryStorage(): Storage {
    const values = new Map<string, string>()
    return {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key)
      }),
      clear: vi.fn(() => values.clear()),
      key: vi.fn((index: number) => [...values.keys()][index] ?? null),
      get length() {
        return values.size
      },
    } as unknown as Storage
  }

  afterEach(() => {
    configurePlayerRuntime('normal')
    vi.unstubAllGlobals()
  })

  it.each(['normal', 'performance'] as const)(
    '%s mode resolves one player and one native audio engine per Pinia instance',
    (mode) => {
      configurePlayerRuntime(mode)
      const pinia = createPinia()
      setActivePinia(pinia)
      const createElement = vi.spyOn(document, 'createElement')

      const uiPlayer = usePlayerStore(pinia)
      const runnerPlayer = usePlayerStore(pinia)

      expect(runnerPlayer).toBe(uiPlayer)
      expect(
        createElement.mock.calls.filter(([tagName]) => String(tagName).toLowerCase() === 'audio'),
      ).toHaveLength(1)

      uiPlayer.dispose()
    },
  )

  it('performance mode never reads or writes the user queue in localStorage', () => {
    configurePlayerRuntime('performance')
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const engine = new FakeEngine()
    const mediaSession = new FakeMediaSession()
    const useStore = createPlayerStore(
      () => engine,
      undefined,
      undefined,
      'player',
      () => mediaSession,
    )
    const pinia = createPinia()
    setActivePinia(pinia)
    const player = useStore(pinia)

    expect(storage.getItem).not.toHaveBeenCalled()
    player.setQueue([track(1)], 0, 'performance-fixture')
    player.dispose()

    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('normal mode keeps the bounded local queue persistence adapter', () => {
    configurePlayerRuntime('normal')
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const engine = new FakeEngine()
    const mediaSession = new FakeMediaSession()
    const player = createPlayerStore(
      () => engine,
      undefined,
      undefined,
      'player',
      () => mediaSession,
    )
    const pinia = createPinia()
    setActivePinia(pinia)
    const runtimePlayer = player(pinia)

    expect(storage.getItem).toHaveBeenCalled()
    runtimePlayer.setQueue([track(1)], 0, 'normal-fixture')
    runtimePlayer.dispose()

    expect(storage.setItem).toHaveBeenCalled()
  })

  it('performance mode uses a no-op like gateway while normal mode uses the native gateway', async () => {
    const nativeCheck = vi.spyOn(nativeTrackLikeGateway, 'check').mockResolvedValue(true)

    configurePlayerRuntime('performance')
    const performanceEngine = new FakeEngine()
    const performanceSession = new FakeMediaSession()
    const performanceUseStore = createPlayerStore(
      () => performanceEngine,
      undefined,
      undefined,
      'player',
      () => performanceSession,
    )
    const performancePinia = createPinia()
    setActivePinia(performancePinia)
    const performanceStore = performanceUseStore(performancePinia)
    await performanceStore.load(track(1), { kind: 'remote', url: 'https://a/1' }, false)
    await vi.waitFor(() => expect(performanceStore.liked).toBe(false))
    expect(nativeCheck).not.toHaveBeenCalled()
    performanceStore.dispose()

    configurePlayerRuntime('normal')
    const normalEngine = new FakeEngine()
    const normalSession = new FakeMediaSession()
    const normalUseStore = createPlayerStore(
      () => normalEngine,
      undefined,
      undefined,
      'player',
      () => normalSession,
    )
    const normalPinia = createPinia()
    setActivePinia(normalPinia)
    const normalStore = normalUseStore(normalPinia)
    await normalStore.load(track(2), { kind: 'remote', url: 'https://a/2' }, false)
    await vi.waitFor(() => expect(normalStore.liked).toBe(true))
    expect(nativeCheck).toHaveBeenCalledWith(2, expect.any(AbortSignal))
    normalStore.dispose()
  })

  it('performance default playback preserves the exact fixture source provenance', async () => {
    const audioUrl = 'http://127.0.0.1:43123/tone-long-mp3.mp3'
    configurePlayerRuntime({
      mode: 'performance',
      audioFixture: { url: audioUrl, mimeType: 'audio/mpeg', sizeBytes: 4096 },
    })
    const engine = new FakeEngine()
    const mediaSession = new FakeMediaSession()
    const useStore = createPlayerStore(
      () => engine,
      undefined,
      undefined,
      'performance-provenance-player',
      () => mediaSession,
    )
    const pinia = createPinia()
    setActivePinia(pinia)
    const player = useStore(pinia)
    player.setQueue([track(999_000)], 0, 'performance-fixture')

    await expect(player.playQueueIndex(0)).resolves.toBe(true)
    expect(player.sourceKind).toBe('remote')
    expect(player.sourceUrl).toBe(audioUrl)
    expect(player.sourceProvenance).toBe('performance-fixture')
    expect(engine.load).toHaveBeenCalledWith(
      { kind: 'remote', url: audioUrl, provenance: 'performance-fixture' },
      expect.any(AbortSignal),
    )
    player.dispose()
  })
})
