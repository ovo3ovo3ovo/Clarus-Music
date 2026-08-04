import { describe, expect, it, vi } from 'vitest'
import {
  NativeArtistGateway,
  mapNativeArtistDetail,
  mapNativeArtistVideoPage,
} from './native-artist'

function nativeTrack(id: number) {
  return {
    kind: 'track',
    id,
    name: `Track ${id}`,
    durationMs: 1000,
    artists: [{ id: 20, name: 'Artist' }],
    album: { id: 30, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  }
}

function nativeAlbum(id: number, albumType = '专辑') {
  return {
    id,
    artistId: 20,
    name: `Album ${id}`,
    coverUrl: `https://img.test/album-${id}.jpg`,
    publishTime: 1_700_000_000_000,
    albumType,
    trackCount: 10,
    explicit: false,
  }
}

function nativeVideo(id: number) {
  return {
    id,
    artistId: 20,
    name: `Video ${id}`,
    coverUrl: `https://img.test/video-${id}.jpg`,
    publishTime: '2026-01-01',
  }
}

function nativeDetail() {
  return {
    artist: {
      id: 20,
      name: 'Artist',
      coverUrl: 'https://img.test/artist.jpg',
      briefDescription: 'Description',
      musicCount: 100,
      albumCount: 20,
      videoCount: 4,
      followed: false,
    },
    popularTracks: [nativeTrack(1)],
    latestRelease: nativeAlbum(2),
    albums: [nativeAlbum(2)],
    eps: [nativeAlbum(3, 'EP')],
    videos: [nativeVideo(4)],
    videosHasMore: true,
    similarArtists: [{ id: 21, name: 'Similar', coverUrl: 'https://img.test/similar.jpg' }],
  }
}

describe('NativeArtistGateway', () => {
  it('maps the narrow artist aggregate and enforces ownership', () => {
    const detail = mapNativeArtistDetail(nativeDetail(), 20)
    expect(detail.artist).toMatchObject({ id: 20, musicCount: 100 })
    expect(detail.albums[0]).toMatchObject({ id: 2, artistId: 20 })

    const wrongOwner = nativeDetail()
    wrongOwner.videos[0]!.artistId = 99
    expect(() => mapNativeArtistDetail(wrongOwner, 20)).toThrow('videos')
  })

  it('validates raw-offset progress on paginated artist videos', () => {
    expect(
      mapNativeArtistVideoPage({ items: [nativeVideo(1)], nextOffset: 100, hasMore: true }, 20, 0),
    ).toMatchObject({ nextOffset: 100, hasMore: true })
    expect(() =>
      mapNativeArtistVideoPage({ items: [], nextOffset: 100, hasMore: true }, 20, 100),
    ).toThrow('metadata')
    expect(() =>
      mapNativeArtistVideoPage({ items: [nativeVideo(1)], nextOffset: 101, hasMore: false }, 20, 0),
    ).toThrow('metadata')
  })

  it('uses cancellable native commands for detail and following', async () => {
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'artist_detail') return nativeDetail()
      if (command === 'set_artist_subscription') return { followed: true }
      return true
    })
    const gateway = new NativeArtistGateway(
      invokeCommand as ConstructorParameters<typeof NativeArtistGateway>[0],
      () => 'artist-1',
      true,
    )

    await expect(gateway.detail(20)).resolves.toMatchObject({ artist: { id: 20 } })
    await expect(gateway.setSubscription(20, true)).resolves.toBe(true)
    expect(invokeCommand).toHaveBeenCalledWith('artist_detail', {
      artistId: 20,
      requestId: 'artist-1',
    })
  })
})
