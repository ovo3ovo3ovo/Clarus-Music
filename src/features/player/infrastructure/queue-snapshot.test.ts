import { describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types/music'
import {
  createLocalPlayerQueuePersistence,
  MAX_PERSISTED_QUEUE_TRACKS,
  parsePlayerQueueSnapshot,
  PLAYER_QUEUE_SNAPSHOT_VERSION,
  type PlayerQueueSnapshot,
} from './queue-snapshot'

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

function snapshot(): PlayerQueueSnapshot {
  return {
    version: PLAYER_QUEUE_SNAPSHOT_VERSION,
    queue: [track(1), track(2)],
    playNextQueue: [track(9)],
    currentTrack: track(1),
    currentIndex: 0,
    currentIsPlayNext: false,
    queueSource: 'album:201',
    playbackOrder: [0, 1],
    repeatMode: 'all',
    shuffle: true,
    reversed: false,
    volume: 0.7,
    progress: 42,
  }
}

describe('player queue snapshots', () => {
  it('round-trips a narrow bounded queue snapshot', () => {
    expect(parsePlayerQueueSnapshot(JSON.parse(JSON.stringify(snapshot())))).toEqual(snapshot())
  })

  it('rejects malformed, oversized, duplicate, and inconsistent queues', () => {
    const valid = snapshot()
    expect(parsePlayerQueueSnapshot({ ...valid, version: 2 })).toBeNull()
    expect(
      parsePlayerQueueSnapshot({
        ...valid,
        queue: Array.from({ length: MAX_PERSISTED_QUEUE_TRACKS + 1 }, (_, index) =>
          track(index + 1),
        ),
      }),
    ).toBeNull()
    expect(parsePlayerQueueSnapshot({ ...valid, queue: [track(1), track(1)] })).toBeNull()
    expect(parsePlayerQueueSnapshot({ ...valid, playbackOrder: [0, 0] })).toBeNull()
    expect(parsePlayerQueueSnapshot({ ...valid, currentTrack: track(2) })).toBeNull()
  })

  it('removes corrupt storage and never exposes unparsed values', () => {
    const values = new Map<string, string>([['queue', '{broken']])
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const persistence = createLocalPlayerQueuePersistence(storage, 'queue')
    expect(persistence.load()).toBeNull()
    expect(storage.removeItem).toHaveBeenCalledWith('queue')
    persistence.save(snapshot())
    expect(persistence.load()).toEqual(snapshot())
    persistence.clear()
    expect(values.has('queue')).toBe(false)
  })

  it('does not rewrite the queue blob when only playback metadata changes', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const persistence = createLocalPlayerQueuePersistence(storage, 'queue')
    const initial = snapshot()
    persistence.save(initial)
    persistence.save({ ...initial, volume: 0.2, progress: 12 })

    expect(
      storage.setItem.mock.calls.filter(([key]) => key.startsWith('queue.queue')),
    ).toHaveLength(1)
    expect(
      storage.setItem.mock.calls.filter(([key]) => key.startsWith('queue.state')),
    ).toHaveLength(2)
    expect(persistence.load()).toEqual({ ...initial, volume: 0.2, progress: 12 })
  })

  it('keeps a legacy combined snapshot for older app rollback without rewriting it on state-only saves', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const persistence = createLocalPlayerQueuePersistence(storage, 'queue')
    const initial = snapshot()
    persistence.save(initial)
    persistence.save({ ...initial, volume: 0.2, progress: 12 })

    expect(JSON.parse(values.get('queue') ?? 'null')).toEqual(initial)
    expect(values.has('queue.meta')).toBe(true)
    expect(persistence.load()).toEqual({ ...initial, volume: 0.2, progress: 12 })
  })

  it('prefers a valid legacy snapshot changed by an older app over a stale split marker', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const persistence = createLocalPlayerQueuePersistence(storage, 'queue')
    const initial = snapshot()
    const next = {
      ...initial,
      queue: [initial.queue[0]!, track(3)],
      currentTrack: initial.queue[0]!,
      queueSource: 'album:202',
      playbackOrder: [0, 1],
    }
    persistence.save(initial)
    persistence.save(next)

    // Simulate an older app writing the legacy key while leaving the new
    // marker untouched during a rollback window.
    values.set('queue', JSON.stringify(initial))

    expect(createLocalPlayerQueuePersistence(storage, 'queue').load()).toEqual(initial)
  })

  it('rehydrates split bookkeeping after a reload', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const initial = snapshot()
    createLocalPlayerQueuePersistence(storage, 'queue').save(initial)

    const reloaded = createLocalPlayerQueuePersistence(storage, 'queue')
    const restored = reloaded.load()
    expect(restored).toEqual(initial)
    expect(restored).not.toBeNull()
    reloaded.save({ ...restored!, volume: 0.2, progress: 12 })

    expect(
      storage.setItem.mock.calls.filter(([key]) => key.startsWith('queue.queue')),
    ).toHaveLength(1)
    expect(
      storage.setItem.mock.calls.filter(([key]) => key.startsWith('queue.state')),
    ).toHaveLength(2)
    expect(reloaded.load()).toEqual({ ...initial, volume: 0.2, progress: 12 })
  })

  it('keeps the last committed snapshot when a split write is interrupted', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const initial = snapshot()
    createLocalPlayerQueuePersistence(storage, 'queue').save(initial)

    // A crash after publishing a new record but before publishing its marker
    // must leave the marker-referenced generation available for reload.
    values.set(
      'queue.queue.2',
      JSON.stringify({
        storageVersion: 1,
        revision: 2,
        queue: initial.queue,
        playNextQueue: initial.playNextQueue,
        playbackOrder: initial.playbackOrder,
        queueSource: initial.queueSource,
      }),
    )

    const restored = createLocalPlayerQueuePersistence(storage, 'queue').load()
    expect(restored).toEqual(initial)
    expect(values.has('queue')).toBe(true)
    expect(values.has('queue.queue.1')).toBe(true)
  })

  it('falls back to the previous committed generation when the marker is incomplete', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const initial = snapshot()
    createLocalPlayerQueuePersistence(storage, 'queue').save(initial)

    // A marker may survive after one of the referenced records is lost or
    // corrupted. The previous generation is still a complete snapshot and
    // must be preferred over clearing all persisted playback state.
    values.set(
      'queue.meta',
      JSON.stringify({
        storageVersion: 1,
        storage: 'split',
        queueRevision: 2,
        stateRevision: 2,
        previousQueueRevision: 1,
        previousStateRevision: 1,
      }),
    )

    const restored = createLocalPlayerQueuePersistence(storage, 'queue').load()
    expect(restored).toEqual(initial)
    expect(values.has('queue.meta')).toBe(true)
    expect(values.has('queue.queue.1')).toBe(true)
    expect(values.has('queue.state.1')).toBe(true)
  })

  it('rejects a mixed current generation and recovers the complete previous pair', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const initial = snapshot()
    createLocalPlayerQueuePersistence(storage, 'queue').save(initial)
    values.set(
      'queue.queue.2',
      JSON.stringify({
        storageVersion: 1,
        revision: 2,
        queue: [track(99)],
        playNextQueue: initial.playNextQueue,
        playbackOrder: [],
        queueSource: 'corrupt-current-generation',
      }),
    )
    values.set(
      'queue.state.2',
      JSON.stringify({
        storageVersion: 1,
        revision: 1,
        currentTrack: initial.currentTrack,
        currentIndex: initial.currentIndex,
        currentIsPlayNext: initial.currentIsPlayNext,
        repeatMode: initial.repeatMode,
        shuffle: initial.shuffle,
        reversed: initial.reversed,
        volume: initial.volume,
        progress: initial.progress,
      }),
    )
    values.set(
      'queue.meta',
      JSON.stringify({
        storageVersion: 1,
        storage: 'split',
        queueRevision: 2,
        stateRevision: 2,
        previousQueueRevision: 1,
        previousStateRevision: 1,
      }),
    )

    expect(createLocalPlayerQueuePersistence(storage, 'queue').load()).toEqual(initial)
  })

  it('uses a valid legacy shadow when the current marker is malformed', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const initial = snapshot()
    createLocalPlayerQueuePersistence(storage, 'queue').save(initial)
    values.set(
      'queue.meta',
      JSON.stringify({
        storageVersion: 1,
        storage: 'split',
        queueRevision: 'not-a-revision',
        stateRevision: 0,
        previousQueueRevision: null,
        previousStateRevision: null,
      }),
    )

    expect(createLocalPlayerQueuePersistence(storage, 'queue').load()).toEqual(initial)
    expect(values.has('queue.meta')).toBe(false)
    expect(values.has('queue')).toBe(true)
  })

  it('falls back to the legacy shadow when a marker has no usable generation', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const initial = snapshot()
    createLocalPlayerQueuePersistence(storage, 'queue').save(initial)
    values.set(
      'queue.meta',
      JSON.stringify({
        storageVersion: 1,
        storage: 'split',
        queueRevision: 99,
        stateRevision: 99,
        previousQueueRevision: null,
        previousStateRevision: null,
      }),
    )

    const restored = createLocalPlayerQueuePersistence(storage, 'queue').load()
    expect(restored).toEqual(initial)
    expect(values.has('queue')).toBe(true)
    expect(values.has('queue.meta')).toBe(false)
  })

  it('keeps the previous split snapshot when a later storage write fails', () => {
    const values = new Map<string, string>()
    let failStateWrite = false
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        if (failStateWrite && key.startsWith('queue.state')) throw new Error('quota')
        values.set(key, value)
      }),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const persistence = createLocalPlayerQueuePersistence(storage, 'queue')
    const initial = snapshot()
    persistence.save(initial)
    failStateWrite = true

    expect(() => persistence.save({ ...initial, volume: 0.1 })).toThrow('quota')
    expect(createLocalPlayerQueuePersistence(storage, 'queue').load()).toEqual(initial)
  })

  it('loads the previous fixed-key split format before migrating on save', () => {
    const values = new Map<string, string>([
      ['queue', JSON.stringify({ storageVersion: 1, storage: 'split', revision: 7 })],
      [
        'queue.queue',
        JSON.stringify({
          storageVersion: 1,
          revision: 7,
          queue: snapshot().queue,
          playNextQueue: snapshot().playNextQueue,
          playbackOrder: snapshot().playbackOrder,
          queueSource: snapshot().queueSource,
        }),
      ],
      [
        'queue.state',
        JSON.stringify({
          storageVersion: 1,
          revision: 7,
          currentTrack: snapshot().currentTrack,
          currentIndex: snapshot().currentIndex,
          currentIsPlayNext: snapshot().currentIsPlayNext,
          repeatMode: snapshot().repeatMode,
          shuffle: snapshot().shuffle,
          reversed: snapshot().reversed,
          volume: snapshot().volume,
          progress: snapshot().progress,
        }),
      ],
    ])
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }

    const persistence = createLocalPlayerQueuePersistence(storage, 'queue')
    expect(persistence.load()).toEqual(snapshot())
    persistence.save({ ...snapshot(), volume: 0.2 })
    expect(values.has('queue.queue.1')).toBe(true)
    expect(values.has('queue.state.1')).toBe(true)
  })

  it('preserves clear errors while attempting to remove all split records', () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn((key: string) => {
        if (key === 'queue') throw new Error('storage disabled')
      }),
    }
    const persistence = createLocalPlayerQueuePersistence(storage, 'queue')

    expect(() => persistence.clear()).toThrow('storage disabled')
    expect(storage.removeItem).toHaveBeenCalledWith('queue.queue')
    expect(storage.removeItem).toHaveBeenCalledWith('queue.state')
  })
})
