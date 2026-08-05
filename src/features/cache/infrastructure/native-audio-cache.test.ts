import { describe, expect, it, vi } from 'vitest'
import { NativeAudioCacheGateway, mapNativeCacheStats } from './native-audio-cache'

describe('native audio cache boundary', () => {
  it('maps bounded native metadata and rejects impossible totals', () => {
    const limitBytes = 128 * 1024 * 1024
    expect(
      mapNativeCacheStats({ entryCount: 3, totalBytes: 10, leasedEntries: 0, limitBytes }),
    ).toEqual({ trackCount: 3, totalBytes: 10, limitBytes })
    expect(() =>
      mapNativeCacheStats({
        entryCount: 3,
        totalBytes: limitBytes + 1,
        leasedEntries: 0,
        limitBytes,
      }),
    ).toThrow('Invalid audio cache statistics')
    expect(() =>
      mapNativeCacheStats({ entryCount: -1, totalBytes: 0, leasedEntries: 0, limitBytes }),
    ).toThrow('Invalid audio cache statistics')
    expect(
      mapNativeCacheStats({
        entryCount: 1,
        totalBytes: limitBytes + 1,
        leasedEntries: 1,
        limitBytes,
      }),
    ).toEqual({ trackCount: 1, totalBytes: limitBytes + 1, limitBytes })
  })

  it('maps a cache hit to raw IPC bytes for a seek-safe Blob', async () => {
    const bytes = new Uint8Array(2048).buffer
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'lookup_audio_cache') {
        return {
          filePath: '/cache/audio-v1/song.mp3',
          mimeType: 'audio/mpeg',
          sizeBytes: 2048,
          leaseId: 'audio-cache-1',
        }
      }
      if (command === 'read_audio_cache_bytes') return bytes
      return true
    })
    const gateway = new NativeAudioCacheGateway(
      invokeCommand as unknown as ConstructorParameters<typeof NativeAudioCacheGateway>[0],
      true,
      undefined,
      () => {
        throw new Error('asset protocol unavailable')
      },
    )

    const source = await gateway.lookup(42, '320000')
    expect(source).toEqual({ kind: 'bytes', bytes, mimeType: 'audio/mpeg' })
    expect(invokeCommand).toHaveBeenCalledWith('read_audio_cache_bytes', {
      leaseId: 'audio-cache-1',
    })
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('release_audio_cache_lease', {
        leaseId: 'audio-cache-1',
      })
    })
    expect(
      invokeCommand.mock.calls.filter(([command]) => command === 'release_audio_cache_lease'),
    ).toHaveLength(1)
  })

  it('maps a cache hit to a managed asset URL and holds the lease until release', async () => {
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'lookup_audio_cache') {
        return {
          filePath: '/cache/audio-v1/song.mp3',
          mimeType: 'audio/mpeg',
          sizeBytes: 2048,
          leaseId: 'audio-cache-managed',
        }
      }
      return true
    })
    const gateway = new NativeAudioCacheGateway(
      invokeCommand as unknown as ConstructorParameters<typeof NativeAudioCacheGateway>[0],
      true,
      undefined,
      (filePath) => `asset://localhost/${encodeURIComponent(filePath)}`,
    )

    const source = await gateway.lookup(42, '320000')

    expect(source).toMatchObject({
      kind: 'managed-url',
      url: 'asset://localhost/%2Fcache%2Faudio-v1%2Fsong.mp3',
      mimeType: 'audio/mpeg',
    })
    expect(invokeCommand).not.toHaveBeenCalledWith('read_audio_cache_bytes', expect.anything())
    expect(invokeCommand).not.toHaveBeenCalledWith('release_audio_cache_lease', expect.anything())

    if (source?.kind !== 'managed-url') throw new Error('expected managed URL source')
    source.release()
    source.release()
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('release_audio_cache_lease', {
        leaseId: 'audio-cache-managed',
      })
    })
    expect(
      invokeCommand.mock.calls.filter(([command]) => command === 'release_audio_cache_lease'),
    ).toHaveLength(1)
  })

  it('downloads and returns local bytes before the first playback', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'store_audio_cache') return { stored: true }
      if (command === 'lookup_audio_cache') {
        return {
          filePath: '/cache/audio-v1/song.mp3',
          mimeType: 'audio/mpeg',
          sizeBytes: 4,
          leaseId: 'audio-cache-first-play',
        }
      }
      if (command === 'read_audio_cache_bytes') return bytes
      return true
    })
    const gateway = new NativeAudioCacheGateway(
      invokeCommand as unknown as ConstructorParameters<typeof NativeAudioCacheGateway>[0],
      true,
      () => 'cache-first-play',
      () => {
        throw new Error('asset protocol unavailable')
      },
    )

    await expect(
      gateway.prepare({
        trackId: 42,
        quality: '320000',
        sourceUrl: 'https://audio.test/song.mp3',
        mimeType: 'audio/mpeg',
        expectedSizeBytes: 4,
      }),
    ).resolves.toEqual({ kind: 'bytes', bytes, mimeType: 'audio/mpeg' })

    expect(invokeCommand.mock.calls.map(([command]) => command).slice(0, 3)).toEqual([
      'store_audio_cache',
      'lookup_audio_cache',
      'read_audio_cache_bytes',
    ])
  })

  it('cancels the previous first-play preparation when a new source arrives', async () => {
    const stores: string[] = []
    const invokeCommand = vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'cancel_music_request') return Promise.resolve(true)
      if (command === 'store_audio_cache') {
        stores.push(String(args?.requestId))
        return new Promise(() => undefined)
      }
      return Promise.resolve(null)
    })
    const requestIds = ['cache-1', 'cache-2'][Symbol.iterator]()
    const gateway = new NativeAudioCacheGateway(
      invokeCommand as unknown as ConstructorParameters<typeof NativeAudioCacheGateway>[0],
      true,
      () => requestIds.next().value ?? 'unexpected',
    )
    const request = {
      trackId: 1,
      quality: '320000' as const,
      sourceUrl: 'https://audio.test/one.mp3',
      mimeType: 'audio/mpeg',
      expectedSizeBytes: 100,
    }

    const first = gateway.prepare(request)
    void first.catch(() => undefined)
    await vi.waitFor(() => expect(stores).toEqual(['cache-1']))
    const second = gateway.prepare({ ...request, trackId: 2 })
    void second.catch(() => undefined)

    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('cancel_music_request', {
        requestId: 'cache-1',
      })
      expect(stores).toEqual(['cache-1', 'cache-2'])
    })
  })

  it('clears native entries before refreshing authoritative statistics', async () => {
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'audio_cache_stats') {
        return {
          entryCount: 1,
          totalBytes: 1024,
          leasedEntries: 0,
          limitBytes: 1024 * 1024 * 1024,
        }
      }
      return { removedEntries: 2 }
    })
    const gateway = new NativeAudioCacheGateway(
      invokeCommand as unknown as ConstructorParameters<typeof NativeAudioCacheGateway>[0],
      true,
    )

    await expect(gateway.clear()).resolves.toEqual({
      trackCount: 1,
      totalBytes: 1024,
      limitBytes: 1024 * 1024 * 1024,
    })
    expect(invokeCommand.mock.calls.map(([command]) => command)).toEqual([
      'clear_audio_cache',
      'audio_cache_stats',
    ])
  })

  it('does not invoke native cache commands in browser previews', async () => {
    const invokeCommand = vi.fn()
    const gateway = new NativeAudioCacheGateway(invokeCommand, false)

    await expect(gateway.lookup(1, '320000')).resolves.toBeNull()
    await expect(
      gateway.prepare({
        trackId: 1,
        quality: '320000',
        sourceUrl: 'https://audio.test/song.mp3',
        mimeType: 'audio/mpeg',
        expectedSizeBytes: 100,
      }),
    ).resolves.toBeNull()
    await expect(gateway.stats()).resolves.toEqual({
      trackCount: 0,
      totalBytes: 0,
      limitBytes: null,
    })
    await expect(gateway.clear()).resolves.toEqual({
      trackCount: 0,
      totalBytes: 0,
      limitBytes: null,
    })
    expect(invokeCommand).not.toHaveBeenCalled()
  })
})
