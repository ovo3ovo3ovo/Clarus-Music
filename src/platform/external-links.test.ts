import { describe, expect, it, vi } from 'vitest'
import { NativeExternalLinkGateway } from './external-links'

describe('NativeExternalLinkGateway', () => {
  it('opens a validated song id through the native macOS command', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined)
    const gateway = new NativeExternalLinkGateway(invokeCommand, true)

    await expect(gateway.openNeteaseSong(42)).resolves.toBeUndefined()
    expect(invokeCommand).toHaveBeenCalledWith('open_netease_song', { songId: 42 })
  })

  it('routes album, artist, and MV links through native commands', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined)
    const gateway = new NativeExternalLinkGateway(invokeCommand, true)

    await gateway.openNeteaseAlbum(42)
    await gateway.openNeteaseArtist(42)
    await gateway.openNeteaseMusicVideo(42)

    expect(invokeCommand.mock.calls).toEqual([
      ['open_netease_album', { albumId: 42 }],
      ['open_netease_artist', { artistId: 42 }],
      ['open_netease_music_video', { musicVideoId: 42 }],
    ])
  })

  it('rejects invalid ids and browser-only execution before IPC', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined)
    const desktopGateway = new NativeExternalLinkGateway(invokeCommand, true)
    const browserGateway = new NativeExternalLinkGateway(invokeCommand, false)

    await expect(desktopGateway.openNeteaseSong(0)).rejects.toThrow(
      'songId must be a positive safe integer',
    )
    await expect(browserGateway.openNeteaseSong(42)).rejects.toThrow(
      'Opening NetEase links requires the desktop app',
    )
    expect(invokeCommand).not.toHaveBeenCalled()
  })
})
