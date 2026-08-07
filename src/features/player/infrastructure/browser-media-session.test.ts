import { describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types/music'
import { createBrowserMediaSession, type MediaSessionTransport } from './browser-media-session'

class FakeMetadata {
  readonly init: MediaMetadataInit

  constructor(init: MediaMetadataInit = {}) {
    this.init = init
  }
}

class FakeMediaSession {
  metadata: MediaMetadata | null = null
  playbackState: MediaSessionPlaybackState = 'none'
  readonly handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>()
  readonly positions: (MediaPositionState | undefined)[] = []
  readonly unsupported = new Set<MediaSessionAction>()

  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    if (this.unsupported.has(action))
      throw new DOMException('Unsupported action', 'NotSupportedError')
    this.handlers.set(action, handler)
  }

  setPositionState(state?: MediaPositionState): void {
    this.positions.push(state)
  }
}

function track(): Track {
  return {
    id: 1,
    name: 'Night Drive',
    durationMs: 180_000,
    artists: [
      { id: 2, name: 'Alice' },
      { id: 3, name: 'Bob' },
    ],
    album: { id: 4, name: 'Neon', coverUrl: 'https://img.test/cover.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  }
}

function setup(unsupported: readonly MediaSessionAction[] = []) {
  const session = new FakeMediaSession()
  for (const action of unsupported) session.unsupported.add(action)
  const transport = {
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    previous: vi.fn(async () => undefined),
    next: vi.fn(async () => undefined),
    stop: vi.fn(),
    seekTo: vi.fn(),
    seekBy: vi.fn(),
  } satisfies MediaSessionTransport
  const controller = createBrowserMediaSession(transport, {
    mediaSession: session as unknown as MediaSession,
    MediaMetadata: FakeMetadata as unknown as typeof MediaMetadata,
  })
  return { controller, session, transport }
}

describe('browser media session', () => {
  it('registers actions independently and maps transport details', async () => {
    const { session, transport } = setup(['stop'])

    session.handlers.get('play')?.({ action: 'play' })
    session.handlers.get('pause')?.({ action: 'pause' })
    session.handlers.get('previoustrack')?.({ action: 'previoustrack' })
    session.handlers.get('nexttrack')?.({ action: 'nexttrack' })
    session.handlers.get('seekto')?.({ action: 'seekto', seekTime: 45, fastSeek: true })
    session.handlers.get('seekbackward')?.({ action: 'seekbackward' })
    session.handlers.get('seekforward')?.({ action: 'seekforward', seekOffset: 6 })
    await Promise.resolve()

    expect(session.handlers.has('stop')).toBe(false)
    expect(transport.play).toHaveBeenCalledOnce()
    expect(transport.pause).toHaveBeenCalledOnce()
    expect(transport.previous).toHaveBeenCalledOnce()
    expect(transport.next).toHaveBeenCalledOnce()
    expect(transport.seekTo).toHaveBeenCalledWith(45)
    expect(transport.seekBy).toHaveBeenNthCalledWith(1, -10)
    expect(transport.seekBy).toHaveBeenNthCalledWith(2, 6)
  })

  it('publishes metadata, playback state, and clamped position state', () => {
    const { controller, session } = setup()

    controller.setTrack(track())
    const metadata = session.metadata as unknown as FakeMetadata
    expect(metadata.init).toMatchObject({
      title: 'Night Drive',
      artist: 'Alice, Bob',
      album: 'Neon',
      artwork: [
        {
          src: 'https://img.test/cover.jpg?param=512y512',
          sizes: '512x512',
          type: 'image/jpeg',
        },
      ],
    })

    controller.setPlaybackState('loading')
    expect(session.playbackState).toBe('none')
    controller.setPlaybackState('paused')
    expect(session.playbackState).toBe('paused')
    controller.setPlaybackState('playing')
    expect(session.playbackState).toBe('playing')

    controller.setPositionState(180, 220)
    expect(session.positions.at(-1)).toEqual({ duration: 180, playbackRate: 1, position: 180 })
    controller.setPositionState(180, Number.NaN)
    expect(session.positions.at(-1)).toEqual({ duration: 180, playbackRate: 1, position: 0 })
    controller.setPositionState(0, 10)
    expect(session.positions.at(-1)).toBeUndefined()
  })

  it('clears browser-owned state and suppresses rejected async handlers on dispose', async () => {
    const { controller, session, transport } = setup()
    transport.play.mockRejectedValueOnce(new Error('autoplay denied'))
    session.handlers.get('play')?.({ action: 'play' })
    await Promise.resolve()

    controller.setTrack(track())
    controller.setPlaybackState('playing')
    controller.dispose()

    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    expect(session.positions.at(-1)).toBeUndefined()
    expect([...session.handlers.values()].every((handler) => handler === null)).toBe(true)
  })

  it('keeps transport without metadata and is a no-op without a session', () => {
    const transport = {
      play: vi.fn(),
      pause: vi.fn(),
      previous: vi.fn(),
      next: vi.fn(),
      stop: vi.fn(),
      seekTo: vi.fn(),
      seekBy: vi.fn(),
    }
    const session = new FakeMediaSession()
    const transportOnly = createBrowserMediaSession(transport, {
      mediaSession: session as unknown as MediaSession,
    })
    transportOnly.setTrack(track())
    expect(session.handlers.get('play')).toEqual(expect.any(Function))
    expect(session.metadata).toBeNull()

    const unavailable = createBrowserMediaSession(transport, {})

    expect(() => {
      unavailable.setTrack(track())
      unavailable.setPlaybackState('playing')
      unavailable.setPositionState(180, 20)
      unavailable.dispose()
    }).not.toThrow()
  })
})
