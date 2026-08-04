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
})
