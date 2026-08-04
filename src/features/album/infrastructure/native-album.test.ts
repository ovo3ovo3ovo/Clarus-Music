import { describe, expect, it, vi } from 'vitest'
import { NativeAlbumGateway, mapNativeAlbumDetail } from './native-album'

function nativeTrack(id: number, discAlbumId = 10) {
  return {
    kind: 'track',
    id,
    name: `Track ${id}`,
    durationMs: id * 1000,
    artists: [{ id: 20, name: 'Artist' }],
    album: { id: discAlbumId, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: id === 1,
    playable: true,
    unavailableReason: null,
  }
}

function nativeDetail() {
  return {
    id: 10,
    name: 'Album',
    coverUrl: 'https://img.test/album.jpg',
    artist: { id: 20, name: 'Artist' },
    publishTime: 1_700_000_000_000,
    trackCount: 2,
    durationMs: 3000,
    description: 'Description',
    company: 'Label',
    albumType: '专辑',
    explicit: true,
    subscribed: false,
    discs: [
      { disc: '1', tracks: [nativeTrack(1)] },
      { disc: '2', tracks: [nativeTrack(2)] },
    ],
    moreAlbums: [
      {
        kind: 'album',
        id: 11,
        name: 'Another album',
        coverUrl: 'https://img.test/other.jpg',
        artistId: 20,
        artistName: 'Artist',
      },
    ],
  }
}

describe('NativeAlbumGateway', () => {
  it('maps the narrow album contract and disc order', () => {
    const detail = mapNativeAlbumDetail(nativeDetail(), 10)
    expect(detail.discs.map(({ disc }) => disc)).toEqual(['1', '2'])
    expect(detail.discs[0]?.tracks[0]).toMatchObject({ id: 1, explicit: true })
    expect(detail.moreAlbums[0]).toMatchObject({ id: 11 })
  })

  it('rejects tracks or related albums outside the album contract', () => {
    const wrongTrack = nativeDetail()
    wrongTrack.discs[0]!.tracks = [nativeTrack(1, 99)]
    expect(() => mapNativeAlbumDetail(wrongTrack, 10)).toThrow('disc')

    const duplicateDisc = nativeDetail()
    duplicateDisc.discs[1]!.disc = '1'
    expect(() => mapNativeAlbumDetail(duplicateDisc, 10)).toThrow('track metadata')
  })

  it('uses cancellable native commands for detail and subscription', async () => {
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'album_detail') return nativeDetail()
      if (command === 'set_album_subscription') return { subscribed: true }
      return true
    })
    const gateway = new NativeAlbumGateway(
      invokeCommand as ConstructorParameters<typeof NativeAlbumGateway>[0],
      () => 'album-1',
      true,
    )

    await expect(gateway.detail(10)).resolves.toMatchObject({ id: 10 })
    await expect(gateway.setSubscription(10, true)).resolves.toBe(true)
    expect(invokeCommand).toHaveBeenCalledWith('album_detail', {
      albumId: 10,
      requestId: 'album-1',
    })
  })
})
