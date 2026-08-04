import { describe, expect, it, vi } from 'vitest'
import { mapNativeDailySongs, NativeDailySongsGateway } from './native-daily-songs'

function nativeTrack(id = 10) {
  return {
    kind: 'track',
    id,
    name: `Track ${id}`,
    durationMs: 180000,
    artists: [{ id: 20, name: 'Artist' }],
    album: { id: 30, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  }
}

describe('NativeDailySongsGateway', () => {
  it('maps narrow tracks and rejects duplicate ids', () => {
    expect(mapNativeDailySongs({ tracks: [nativeTrack()] }).tracks[0]?.id).toBe(10)
    expect(() => mapNativeDailySongs({ tracks: [nativeTrack(), nativeTrack()] })).toThrow(
      'duplicate tracks',
    )
    expect(() => mapNativeDailySongs({ tracks: new Array(101).fill(nativeTrack()) })).toThrow(
      'Invalid daily songs response',
    )
  })

  it('cancels native work when the caller aborts', async () => {
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'daily_songs') return await new Promise(() => undefined)
      return true
    })
    const gateway = new NativeDailySongsGateway(
      invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
      () => 'daily-request',
      true,
    )
    const controller = new AbortController()
    const pending = gateway.load(controller.signal)
    controller.abort('Route changed')
    await Promise.resolve()

    expect(invokeMock).toHaveBeenCalledWith('cancel_music_request', {
      requestId: 'daily-request',
    })
    void pending.catch(() => undefined)
  })
})
