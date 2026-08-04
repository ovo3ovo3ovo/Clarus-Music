import { describe, expect, it, vi } from 'vitest'
import { NativeMusicVideoGateway, mapNativeMusicVideoDetail } from './native-music-video'

function nativeDetail() {
  return {
    id: 10,
    name: 'MV',
    coverUrl: 'https://img.test/mv.jpg',
    artistId: 20,
    artistName: 'Artist',
    playCount: 30,
    publishTime: '2026-01-01',
    durationMs: 40,
    subscribed: false,
    sources: [
      {
        resolution: 1080,
        url: 'https://video.test/1080.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 100,
      },
      {
        resolution: 720,
        url: 'https://video.test/720.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 80,
      },
    ],
    similarVideos: [
      {
        id: 11,
        name: 'Similar',
        coverUrl: 'https://img.test/similar.jpg',
        artistId: 21,
        artistName: 'Similar Artist',
        durationMs: 50,
      },
    ],
  }
}

describe('NativeMusicVideoGateway', () => {
  it('maps a narrow owned detail with descending unique qualities', () => {
    const detail = mapNativeMusicVideoDetail(nativeDetail(), 10)
    expect(detail.sources.map(({ resolution }) => resolution)).toEqual([1080, 720])
    expect(detail.similarVideos[0]).toMatchObject({ kind: 'musicVideo', id: 11 })

    const duplicate = nativeDetail()
    duplicate.sources[1]!.resolution = 1080
    expect(() => mapNativeMusicVideoDetail(duplicate, 10)).toThrow('sources')
    expect(() => mapNativeMusicVideoDetail(nativeDetail(), 99)).toThrow('detail')
  })

  it('rejects malformed or self-referential related videos', () => {
    const selfReference = nativeDetail()
    selfReference.similarVideos[0]!.id = 10
    expect(() => mapNativeMusicVideoDetail(selfReference, 10)).toThrow('similar')

    const invalidUrl = nativeDetail()
    invalidUrl.sources[0]!.url = 'file:///tmp/video.mp4'
    expect(() => mapNativeMusicVideoDetail(invalidUrl, 10)).toThrow('sources')
  })

  it('uses cancellable native commands for detail and subscription', async () => {
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'music_video_detail') return nativeDetail()
      if (command === 'set_music_video_subscription') return { subscribed: true }
      return true
    })
    const gateway = new NativeMusicVideoGateway(
      invokeCommand as ConstructorParameters<typeof NativeMusicVideoGateway>[0],
      () => 'mv-1',
      true,
    )

    await expect(gateway.detail(10)).resolves.toMatchObject({ id: 10 })
    await expect(gateway.setSubscription(10, true)).resolves.toBe(true)
    expect(invokeCommand).toHaveBeenCalledWith('music_video_detail', {
      videoId: 10,
      requestId: 'mv-1',
    })
  })
})
