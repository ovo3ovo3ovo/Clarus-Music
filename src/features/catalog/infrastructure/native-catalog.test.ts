import { describe, expect, it, vi } from 'vitest'
import {
  NativeCatalogGateway,
  mapNativeSearchOverview,
  mapNativeSearchPage,
} from './native-catalog'
import type { AudioCacheGateway } from '@/features/cache/infrastructure/native-audio-cache'

function cacheGateway(overrides: Partial<AudioCacheGateway> = {}): AudioCacheGateway {
  return {
    lookup: vi.fn(async () => null),
    prepare: vi.fn(async () => null),
    stats: vi.fn(async () => ({ trackCount: 0, totalBytes: 0, limitBytes: null })),
    clear: vi.fn(async () => ({ trackCount: 0, totalBytes: 0, limitBytes: null })),
    ...overrides,
  }
}

function nativeOverview() {
  return {
    tracks: {
      items: [
        {
          kind: 'track',
          id: 186016,
          name: '晴天',
          durationMs: 269000,
          artists: [{ id: 6452, name: '周杰伦' }],
          album: {
            id: 18905,
            name: '叶惠美',
            coverUrl: 'https://img.test/song.jpg',
          },
          aliases: ['Sunny Day'],
          translatedNames: ['Clear Day'],
          explicit: false,
          playable: true,
          unavailableReason: null,
        },
      ],
      total: 1,
      error: null,
    },
    artists: {
      items: [
        {
          kind: 'artist',
          id: 6452,
          name: '周杰伦',
          coverUrl: 'https://img.test/a.jpg',
          description: '华语流行男歌手、音乐人。',
        },
      ],
      total: 1,
      error: null,
    },
    albums: {
      items: [
        {
          kind: 'album',
          id: 18905,
          name: '叶惠美',
          coverUrl: 'https://img.test/b.jpg',
          artistId: 6452,
          artistName: '周杰伦',
        },
      ],
      total: 1,
      error: null,
    },
    playlists: {
      items: [
        {
          kind: 'playlist',
          id: 42,
          name: '精选',
          coverUrl: 'https://img.test/p.jpg',
          creatorName: 'listener',
          trackCount: 20,
        },
      ],
      total: 1,
      error: null,
    },
    musicVideos: {
      items: [
        {
          kind: 'musicVideo',
          id: 7,
          name: 'MV',
          coverUrl: 'https://img.test/mv.jpg',
          artistId: 6452,
          artistName: '周杰伦',
          durationMs: 120000,
        },
      ],
      total: 1,
      error: null,
    },
  }
}

describe('NativeCatalogGateway', () => {
  it('maps the narrow native search contract', () => {
    const overview = mapNativeSearchOverview(nativeOverview())

    expect(overview.tracks.items[0]).toMatchObject({ id: 186016, playable: true })
    expect(overview.artists.items[0]).toMatchObject({
      id: 6452,
      kind: 'artist',
      description: '华语流行男歌手、音乐人。',
    })
    expect(overview.musicVideos.items[0]).toMatchObject({ id: 7, durationMs: 120000 })
  })

  it('rejects unsafe media URLs', async () => {
    const invokeCommand = vi.fn(async () => ({
      url: 'file:///tmp/song.mp3',
    })) as unknown as ConstructorParameters<typeof NativeCatalogGateway>[0]
    const gateway = new NativeCatalogGateway(invokeCommand, () => 'stream-1', true)

    await expect(gateway.resolveStream(1, '320000')).rejects.toThrow('invalid')
  })

  it('uses a managed cache hit without resolving a remote stream', async () => {
    const invokeCommand = vi.fn()
    const cached = {
      kind: 'managed-url' as const,
      url: 'asset://localhost/song.mp3',
      release: vi.fn(),
    }
    const audioCache = cacheGateway({ lookup: vi.fn(async () => cached) })
    const gateway = new NativeCatalogGateway(invokeCommand, () => 'stream-1', true, audioCache)

    await expect(gateway.resolveStream(1, '320000')).resolves.toBe(cached)
    expect(invokeCommand).not.toHaveBeenCalled()
    expect(audioCache.lookup).toHaveBeenCalledWith(1, '320000', undefined)
    expect(audioCache.prepare).not.toHaveBeenCalled()
  })

  it('prepares seek-safe MP3 bytes before the first macOS playback', async () => {
    const invokeCommand = vi.fn(async () => ({
      url: 'https://audio.test/song.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 4096,
      bitrate: 320000,
      durationMs: 120000,
      level: 'exhigh',
    })) as unknown as ConstructorParameters<typeof NativeCatalogGateway>[0]
    const prepared = {
      kind: 'bytes' as const,
      bytes: new Uint8Array([1, 2, 3]).buffer,
      mimeType: 'audio/mpeg',
    }
    const audioCache = cacheGateway({ prepare: vi.fn(async () => prepared) })
    const gateway = new NativeCatalogGateway(invokeCommand, () => 'stream-1', true, audioCache)

    await expect(gateway.resolveStream(1, '999000')).resolves.toBe(prepared)
    expect(invokeCommand).toHaveBeenCalledWith('resolve_stream_url', {
      trackId: 1,
      quality: '320000',
      requestId: 'stream-1',
    })
    expect(audioCache.prepare).toHaveBeenCalledWith(
      {
        trackId: 1,
        quality: '320000',
        sourceUrl: 'https://audio.test/song.mp3',
        mimeType: 'audio/mpeg',
        expectedSizeBytes: 4096,
      },
      undefined,
    )
  })

  it('accepts an unknown-size WebM fallback and schedules format-correct caching', async () => {
    const invokeCommand = vi.fn(async () => ({
      url: 'https://audio.test/song.webm',
      mimeType: 'audio/webm',
      sizeBytes: 0,
      bitrate: 320000,
      durationMs: 120000,
      level: 'unblock:ytdl',
    })) as unknown as ConstructorParameters<typeof NativeCatalogGateway>[0]
    const audioCache = cacheGateway()
    const gateway = new NativeCatalogGateway(invokeCommand, () => 'stream-1', true, audioCache)

    await expect(gateway.resolveStream(1, '320000')).resolves.toEqual({
      kind: 'remote',
      url: 'https://audio.test/song.webm',
    })
    expect(audioCache.prepare).toHaveBeenCalledWith(
      {
        trackId: 1,
        quality: '320000',
        sourceUrl: 'https://audio.test/song.webm',
        mimeType: 'audio/webm',
        expectedSizeBytes: 0,
      },
      undefined,
    )
  })

  it('degrades a local cache failure to one remote stream request', async () => {
    const invokeCommand = vi.fn(async () => ({
      url: 'https://audio.test/song.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 100,
    })) as unknown as ConstructorParameters<typeof NativeCatalogGateway>[0]
    const audioCache = cacheGateway({
      lookup: vi.fn(async () => {
        throw new Error('cache index unavailable')
      }),
    })
    const gateway = new NativeCatalogGateway(invokeCommand, () => 'stream-1', true, audioCache)

    await expect(gateway.resolveStream(1, '320000')).resolves.toEqual({
      kind: 'remote',
      url: 'https://audio.test/song.mp3',
    })
    expect(invokeCommand).toHaveBeenCalledTimes(1)
  })

  it('maps a typed search page and validates forward pagination', () => {
    const page = mapNativeSearchPage(
      {
        searchType: 'tracks',
        items: nativeOverview().tracks.items,
        total: 45,
        nextOffset: 30,
        hasMore: true,
      },
      'tracks',
    )

    expect(page).toMatchObject({ searchType: 'tracks', total: 45, nextOffset: 30, hasMore: true })
    expect(page.items[0]).toMatchObject({ id: 186016 })
    expect(() =>
      mapNativeSearchPage(
        { searchType: 'tracks', items: [], total: 45, nextOffset: 30, hasMore: true },
        'albums',
      ),
    ).toThrow('Invalid search page response')
    expect(() =>
      mapNativeSearchPage(
        { searchType: 'tracks', items: [], total: 45, nextOffset: 30, hasMore: true },
        'tracks',
        30,
      ),
    ).toThrow('Invalid search page metadata')
    expect(() =>
      mapNativeSearchPage(
        { searchType: 'tracks', items: [], total: 20, nextOffset: 30, hasMore: false },
        'tracks',
      ),
    ).toThrow('Invalid search page metadata')
    expect(() =>
      mapNativeSearchPage(
        {
          searchType: 'tracks',
          items: [{ kind: 'track', id: 1 }],
          total: 1,
          nextOffset: 1,
          hasMore: false,
        },
        'tracks',
      ),
    ).toThrow('no valid items')
  })

  it('cancels the native search task when superseded', async () => {
    let rejectRequest: ((reason: unknown) => void) | undefined
    const invokeMock = vi.fn((command: string): Promise<unknown> => {
      if (command === 'cancel_music_request') return Promise.resolve(true)
      return new Promise<unknown>((_resolve, reject) => {
        rejectRequest = reject
      })
    })
    const gateway = new NativeCatalogGateway(
      invokeMock as unknown as ConstructorParameters<typeof NativeCatalogGateway>[0],
      () => 'search-1',
      true,
    )
    const controller = new AbortController()
    const request = gateway.searchOverview('query', controller.signal)

    controller.abort('query changed')
    rejectRequest?.(new Error('cancelled'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(invokeMock).toHaveBeenCalledWith('cancel_music_request', { requestId: 'search-1' })
  })
})
