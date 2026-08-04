import { describe, expect, it } from 'vitest'
import type { Track } from '@/types/music'
import { selectSearchTrack } from './search-playback'

function track(id: number, playable = true): Track {
  return {
    id,
    name: `Track ${id}`,
    durationMs: 1,
    artists: [],
    album: { id, name: `Album ${id}`, coverUrl: 'https://img.test/cover.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable,
    unavailableReason: playable ? null : 'Unavailable',
  }
}

describe('selectSearchTrack', () => {
  it('builds a playable queue and preserves the selected position', () => {
    const selection = selectSearchTrack([track(1), track(2, false), track(3)], 3)

    expect(selection?.queue.map(({ id }) => id)).toEqual([1, 3])
    expect(selection?.index).toBe(1)
    expect(selection?.track.id).toBe(3)
  })

  it('rejects an unavailable or missing selection', () => {
    const tracks = [track(1), track(2, false)]

    expect(selectSearchTrack(tracks, 2)).toBeNull()
    expect(selectSearchTrack(tracks, 99)).toBeNull()
  })
})
