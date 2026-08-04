import { describe, expect, it, vi } from 'vitest'
import { NativePlaylistGateway, mapNativePlaylistDetail } from './native-playlist'

function nativeTrack(id: number) {
  return {
    kind: 'track',
    id,
    name: `Track ${id}`,
    durationMs: 180000,
    artists: [{ id: 2, name: 'Artist' }],
    album: { id: 3, name: 'Album', coverUrl: 'https://img.test/a.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  }
}

function nativeDetail() {
  return {
    id: 42,
    name: 'Playlist',
    coverUrl: 'https://img.test/p.jpg',
    creator: { userId: 9, name: 'Listener' },
    updateTime: 100,
    trackCount: 3,
    description: 'Description',
    private: false,
    subscribed: true,
    trackIds: [1, 2, 3],
    tracks: [nativeTrack(1), nativeTrack(2)],
    nextOffset: 2,
    hasMore: true,
  }
}

describe('NativePlaylistGateway', () => {
  it('maps and validates the narrow detail contract', () => {
    const detail = mapNativePlaylistDetail(nativeDetail(), 42)
    expect(detail).toMatchObject({ id: 42, nextOffset: 2, hasMore: true })
    expect(detail.tracks.map(({ id }) => id)).toEqual([1, 2])
    expect(() => mapNativePlaylistDetail({ ...nativeDetail(), hasMore: false }, 42)).toThrow(
      'metadata',
    )
    expect(() =>
      mapNativePlaylistDetail({ ...nativeDetail(), tracks: [nativeTrack(99)] }, 42),
    ).toThrow('unexpected tracks')
  })

  it('uses cancellable native commands for detail and pages', async () => {
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'playlist_detail') return nativeDetail()
      if (command === 'liked_songs_detail') return nativeDetail()
      if (command === 'playlist_track_page') {
        return { tracks: [nativeTrack(3)], requestedCount: 1 }
      }
      return false
    })
    const gateway = new NativePlaylistGateway(
      invokeCommand as ConstructorParameters<typeof NativePlaylistGateway>[0],
      () => 'playlist-1',
      true,
    )

    await expect(gateway.detail(42)).resolves.toMatchObject({ id: 42 })
    await expect(gateway.likedSongs(9)).resolves.toMatchObject({ creator: { userId: 9 } })
    await expect(gateway.trackPage([3])).resolves.toMatchObject({ requestedCount: 1 })
    expect(invokeCommand).toHaveBeenCalledWith('playlist_detail', {
      playlistId: 42,
      requestId: 'playlist-1',
    })
    expect(invokeCommand).toHaveBeenCalledWith('liked_songs_detail', {
      userId: 9,
      requestId: 'playlist-1',
    })
  })

  it('rejects a liked-songs playlist owned by another account', async () => {
    const invokeCommand = vi.fn(async () => ({
      ...nativeDetail(),
      creator: { userId: 7, name: 'Other listener' },
    }))
    const gateway = new NativePlaylistGateway(
      invokeCommand as ConstructorParameters<typeof NativePlaylistGateway>[0],
      () => 'liked-1',
      true,
    )

    await expect(gateway.likedSongs(9)).rejects.toThrow('unexpected user')
  })

  it('routes owner mutations through cancellable commands', async () => {
    const invokeCommand = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'update_playlist_name') {
        return { playlistId: args?.playlistId, affectedTrackIds: [] }
      }
      if (command === 'update_playlist_description') {
        return { playlistId: args?.playlistId, affectedTrackIds: [] }
      }
      if (command === 'delete_playlist') {
        return { playlistId: args?.playlistId, affectedTrackIds: [] }
      }
      if (command === 'add_playlist_tracks' || command === 'remove_playlist_tracks') {
        return { playlistId: args?.playlistId, affectedTrackIds: args?.trackIds }
      }
      return false
    })
    const gateway = new NativePlaylistGateway(
      invokeCommand as ConstructorParameters<typeof NativePlaylistGateway>[0],
      () => 'mutation-1',
      true,
    )

    await gateway.updateName(42, 'Renamed')
    await gateway.updateDescription(42, 'Updated')
    await gateway.deletePlaylist(42)
    await gateway.addTracks(42, [1, 2])
    await gateway.removeTracks(42, [1])

    expect(invokeCommand).toHaveBeenCalledWith('update_playlist_name', {
      playlistId: 42,
      name: 'Renamed',
      requestId: 'mutation-1',
    })
    expect(invokeCommand).toHaveBeenCalledWith('remove_playlist_tracks', {
      playlistId: 42,
      trackIds: [1],
      requestId: 'mutation-1',
    })
  })
})
