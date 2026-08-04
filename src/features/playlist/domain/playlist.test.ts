import { describe, expect, it } from 'vitest'
import { parsePositiveIntegerRouteParam } from '@/app/route-params'
import type { Track } from '@/types/music'
import { appendPlaylistTrackPage, filterPlaylistTracks, selectPlaylistTrack } from './playlist'

function track(id: number, name = `Track ${id}`, playable = true): Track {
  return {
    id,
    name,
    durationMs: 1,
    artists: [{ id: 10, name: 'Artist' }],
    album: { id: 20, name: 'Album', coverUrl: 'https://img.test/cover.jpg' },
    aliases: ['Alias'],
    translatedNames: [],
    explicit: false,
    playable,
    unavailableReason: playable ? null : 'Unavailable',
  }
}

describe('playlist domain', () => {
  it('accepts only positive safe route ids', () => {
    expect(parsePositiveIntegerRouteParam('42')).toBe(42)
    expect(parsePositiveIntegerRouteParam(['42'])).toBe(42)
    expect(parsePositiveIntegerRouteParam('0')).toBeNull()
    expect(parsePositiveIntegerRouteParam('42x')).toBeNull()
    expect(parsePositiveIntegerRouteParam('9007199254740992')).toBeNull()
  })

  it('advances pages by requested ids and deduplicates mapped tracks', () => {
    const result = appendPlaylistTrackPage([track(1)], 1, 4, {
      tracks: [track(1), track(2)],
      requestedCount: 2,
    })

    expect(result.tracks.map(({ id }) => id)).toEqual([1, 2])
    expect(result).toMatchObject({ nextOffset: 3, hasMore: true })
  })

  it('rejects pagination that advances beyond the authoritative id list', () => {
    expect(() => appendPlaylistTrackPage([], 90, 100, { tracks: [], requestedCount: 11 })).toThrow(
      'Invalid playlist pagination metadata',
    )
  })

  it('searches track, artist, album, and alias text without mutating the list', () => {
    const tracks = [track(1, 'Blue Sky'), track(2, 'Other')]
    expect(filterPlaylistTracks(tracks, 'blue')).toEqual([tracks[0]])
    expect(filterPlaylistTracks(tracks, 'artist')).toEqual(tracks)
    expect(filterPlaylistTracks(tracks, '')).toBe(tracks)
  })

  it('creates a playable queue at the selected track', () => {
    const selection = selectPlaylistTrack([track(1), track(2, 'Locked', false), track(3)], 3)
    expect(selection?.queue.map(({ id }) => id)).toEqual([1, 3])
    expect(selection?.index).toBe(1)
    expect(selectPlaylistTrack([track(2, 'Locked', false)])).toBeNull()
  })
})
