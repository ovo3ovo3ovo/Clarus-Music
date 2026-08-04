import { describe, expect, it, vi } from 'vitest'
import { NativeLibraryGateway } from './native-library'

const track = {
  kind: 'track',
  id: 11,
  name: 'Track',
  durationMs: 180000,
  artists: [{ id: 7, name: 'Artist' }],
  album: { id: 8, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
  aliases: [],
  translatedNames: [],
  explicit: false,
  playable: true,
  unavailableReason: null,
}

const likedSongs = {
  id: 1,
  name: 'Liked Songs',
  coverUrl: 'https://img.test/liked.jpg',
  creator: { userId: 9, name: 'Listener' },
  updateTime: 100,
  trackCount: 1,
  description: '',
  private: false,
  subscribed: false,
  trackIds: [11],
  tracks: [track],
  nextOffset: 1,
  hasMore: false,
}

const likedPlaylist = {
  kind: 'playlist',
  id: 1,
  name: 'Liked Songs',
  coverUrl: 'https://img.test/liked.jpg',
  creatorId: 9,
  creatorName: 'Listener',
  trackCount: 1,
}

describe('NativeLibraryGateway', () => {
  it('maps an owner-validated overview and forwards cancellation', async () => {
    let rejectOverview: ((reason: unknown) => void) | undefined
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'cancel_music_request') return true
      return await new Promise((_, reject) => {
        rejectOverview = reject
        expect(args).toMatchObject({ userId: 9, requestId: 'library-request' })
      })
    })
    const gateway = new NativeLibraryGateway(
      invoke as ConstructorParameters<typeof NativeLibraryGateway>[0],
      () => 'library-request',
      true,
    )
    const controller = new AbortController()
    const request = gateway.overview(9, controller.signal)
    controller.abort('route changed')
    rejectOverview?.(new Error('cancelled'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke).toHaveBeenCalledWith('cancel_music_request', {
      requestId: 'library-request',
    })
  })

  it('rejects an overview when the liked playlist owner changes', async () => {
    const invoke = vi.fn(async () => ({
      likedSongs: { ...likedSongs, creator: { userId: 10, name: 'Other' } },
      playlists: { items: [likedPlaylist], nextOffset: 1, hasMore: false },
    }))
    const gateway = new NativeLibraryGateway(
      invoke as ConstructorParameters<typeof NativeLibraryGateway>[0],
      () => 'id',
      true,
    )

    await expect(gateway.overview(9)).rejects.toThrow('unexpected user')
  })

  it('rejects duplicate cards and non-advancing pages', async () => {
    const invoke = vi.fn(async () => ({
      items: [likedPlaylist, likedPlaylist],
      nextOffset: 50,
      hasMore: true,
    }))
    const gateway = new NativeLibraryGateway(
      invoke as ConstructorParameters<typeof NativeLibraryGateway>[0],
      () => 'id',
      true,
    )

    await expect(gateway.playlistPage(9, 50)).rejects.toThrow('page metadata')
  })

  it('maps catalog, history, and create responses strictly', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'library_catalog_page') {
        return {
          section: 'albums',
          items: [
            {
              kind: 'album',
              id: 2,
              name: 'Album',
              coverUrl: 'https://img.test/a.jpg',
              artistId: 7,
              artistName: 'Artist',
            },
          ],
          nextOffset: 1,
          hasMore: false,
        }
      }
      if (command === 'library_history') {
        return { period: 'week', items: [{ track, playCount: 12 }] }
      }
      if (command === 'create_library_playlist') {
        return { ...likedPlaylist, id: 3, name: 'New playlist' }
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const gateway = new NativeLibraryGateway(
      invoke as ConstructorParameters<typeof NativeLibraryGateway>[0],
      () => 'id',
      true,
    )

    await expect(gateway.catalogPage('albums', 0)).resolves.toMatchObject({
      section: 'albums',
      items: [{ id: 2 }],
    })
    await expect(gateway.history(9, 'week')).resolves.toMatchObject({
      items: [{ playCount: 12 }],
    })
    await expect(gateway.createPlaylist('New playlist', false)).resolves.toMatchObject({ id: 3 })
  })
})
