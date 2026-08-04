import { describe, expect, it, vi } from 'vitest'
import { NativeTrackLikeGateway } from './native-like'

describe('NativeTrackLikeGateway', () => {
  it('maps check and set responses and forwards request ids', async () => {
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === 'check_song_like') return { liked: true }
      if (command === 'set_song_like') return { liked: false }
      return false
    })
    const gateway = new NativeTrackLikeGateway(
      invokeCommand as ConstructorParameters<typeof NativeTrackLikeGateway>[0],
      () => 'like-1',
      true,
    )

    await expect(gateway.check(42)).resolves.toBe(true)
    await expect(gateway.setLiked(42, false)).resolves.toBe(false)
    expect(invokeCommand).toHaveBeenCalledWith('check_song_like', {
      trackId: 42,
      requestId: 'like-1',
    })
    expect(invokeCommand).toHaveBeenCalledWith('set_song_like', {
      trackId: 42,
      liked: false,
      requestId: 'like-1',
    })
  })

  it('cancels an in-flight request through the native cancellation command', async () => {
    let release: ((value: unknown) => void) | undefined
    const invokeCommand = vi.fn((command: string) => {
      if (command === 'check_song_like') {
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return Promise.resolve(false)
    })
    const gateway = new NativeTrackLikeGateway(
      invokeCommand as ConstructorParameters<typeof NativeTrackLikeGateway>[0],
      () => 'like-2',
      true,
    )
    const controller = new AbortController()
    const request = gateway.check(42, controller.signal)
    controller.abort('route changed')
    release?.({ liked: true })

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(invokeCommand).toHaveBeenCalledWith('cancel_music_request', {
      requestId: 'like-2',
    })
  })

  it('rejects malformed responses', async () => {
    const gateway = new NativeTrackLikeGateway(
      vi.fn(async () => ({ liked: 'yes' })) as ConstructorParameters<
        typeof NativeTrackLikeGateway
      >[0],
      () => 'like-3',
      true,
    )
    await expect(gateway.check(42)).rejects.toThrow('Invalid song like response')
  })
})
