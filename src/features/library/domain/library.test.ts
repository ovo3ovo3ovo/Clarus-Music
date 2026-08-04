import { describe, expect, it } from 'vitest'
import { appendUniqueItems, filterLibraryPlaylists, type LibraryPlaylist } from './library'

function playlist(id: number, creatorId: number): LibraryPlaylist {
  return {
    kind: 'playlist',
    id,
    name: `Playlist ${id}`,
    coverUrl: `https://img.test/${id}.jpg`,
    creatorId,
    creatorName: `User ${creatorId}`,
    trackCount: 10,
  }
}

describe('library domain', () => {
  it('appends pages without growing duplicate cards', () => {
    expect(appendUniqueItems([playlist(1, 9)], [playlist(1, 9), playlist(2, 10)])).toEqual([
      playlist(1, 9),
      playlist(2, 10),
    ])
  })

  it('excludes the liked playlist and filters by ownership', () => {
    const playlists = [playlist(1, 9), playlist(2, 9), playlist(3, 10)]
    expect(filterLibraryPlaylists(playlists, 'all', 9, 1).map(({ id }) => id)).toEqual([2, 3])
    expect(filterLibraryPlaylists(playlists, 'mine', 9, 1).map(({ id }) => id)).toEqual([2])
    expect(filterLibraryPlaylists(playlists, 'liked', 9, 1).map(({ id }) => id)).toEqual([3])
  })
})
