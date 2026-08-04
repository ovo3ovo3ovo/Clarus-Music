import { describe, expect, it } from 'vitest'
import type { Track } from '@/types/music'
import { formatArtistAlbumType, mergeArtistVideos, selectArtistTrack } from './artist'

function track(id: number, playable = true): Track {
  return {
    id,
    name: `Track ${id}`,
    durationMs: 1,
    artists: [{ id: 20, name: 'Artist' }],
    album: { id: 30, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable,
    unavailableReason: playable ? null : 'Unavailable',
  }
}

describe('artist domain', () => {
  it('builds a playable popular-song queue without unavailable tracks', () => {
    const selection = selectArtistTrack([track(1), track(2, false), track(3)], 3)
    expect(selection?.queue.map(({ id }) => id)).toEqual([1, 3])
    expect(selection?.index).toBe(1)
  })

  it('formats the legacy artist album subtitles', () => {
    const album = {
      id: 1,
      artistId: 20,
      name: 'EP',
      coverUrl: 'https://img.test/ep.jpg',
      publishTime: 0,
      albumType: 'EP/Single',
      trackCount: 1,
      explicit: false,
    }
    expect(formatArtistAlbumType(album)).toBe('Single')
    expect(formatArtistAlbumType({ ...album, trackCount: 3 })).toBe('EP')
  })

  it('merges paginated videos by id while preserving insertion order', () => {
    const video = (id: number) => ({
      id,
      artistId: 20,
      name: `Video ${id}`,
      coverUrl: `https://img.test/${id}.jpg`,
      publishTime: '',
    })
    expect(
      mergeArtistVideos([video(1), video(2)], {
        items: [video(2), video(3)],
        nextOffset: 4,
        hasMore: false,
      }).map(({ id }) => id),
    ).toEqual([1, 2, 3])
  })
})
