import { describe, expect, it } from 'vitest'
import type { Track } from '@/types/music'
import { selectDailySong } from './daily-songs'

function track(id: number, playable = true): Track {
  return {
    id,
    name: `Track ${id}`,
    durationMs: 180000,
    artists: [{ id: 20, name: 'Artist' }],
    album: { id: 30, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable,
    unavailableReason: playable ? null : 'Unavailable',
  }
}

describe('selectDailySong', () => {
  it('builds the queue from playable recommendations and preserves selection', () => {
    const selection = selectDailySong([track(1), track(2, false), track(3)], 3)
    expect(selection?.queue.map(({ id }) => id)).toEqual([1, 3])
    expect(selection?.index).toBe(1)
    expect(selection?.track.id).toBe(3)
  })

  it('returns null for an unavailable or unknown selection', () => {
    expect(selectDailySong([track(1, false)])).toBeNull()
    expect(selectDailySong([track(1)], 9)).toBeNull()
  })
})
