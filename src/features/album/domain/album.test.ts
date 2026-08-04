import { describe, expect, it } from 'vitest'
import type { Track } from '@/types/music'
import { flattenAlbumTracks, formatAlbumType, selectAlbumTrack, splitAlbumTitle } from './album'

function track(id: number, playable = true): Track {
  return {
    id,
    name: `Track ${id}`,
    durationMs: 1,
    artists: [{ id: 2, name: 'Artist' }],
    album: { id: 3, name: 'Album', coverUrl: 'https://img.test/a.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable,
    unavailableReason: playable ? null : 'Unavailable',
  }
}

describe('album domain', () => {
  it('preserves the legacy soundtrack and edition title split', () => {
    expect(splitAlbumTitle('Film - Original Motion Picture Soundtrack (Deluxe Edition)')).toEqual({
      title: 'Film',
      subtitle: 'Original Motion Picture Soundtrack · Deluxe Edition',
    })
  })

  it('normalizes NetEase album types', () => {
    expect(formatAlbumType('EP/Single', 1)).toBe('Single')
    expect(formatAlbumType('EP/Single', 4)).toBe('EP')
    expect(formatAlbumType('专辑', 10)).toBe('Album')
  })

  it('flattens discs and builds a playable queue without unavailable tracks', () => {
    const tracks = flattenAlbumTracks([
      { disc: '1', tracks: [track(1), track(2, false)] },
      { disc: '2', tracks: [track(3)] },
    ])
    expect(tracks.map(({ id }) => id)).toEqual([1, 2, 3])
    expect(selectAlbumTrack(tracks, 3)?.queue.map(({ id }) => id)).toEqual([1, 3])
    expect(selectAlbumTrack(tracks, 3)?.index).toBe(1)
  })
})
