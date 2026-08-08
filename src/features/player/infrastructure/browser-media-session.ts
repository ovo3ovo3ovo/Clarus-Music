import type { AudioEngineState } from '@/features/player/domain/audio-engine'
import { coverImageUrl } from '@/platform/cover-image'
import type { Track } from '@/types/music'

export interface MediaSessionTransport {
  play(): void | boolean | Promise<void | boolean>
  pause(): void | boolean | Promise<void | boolean>
  previous(): void | boolean | Promise<void | boolean>
  next(): void | boolean | Promise<void | boolean>
  stop(): void | boolean | Promise<void | boolean>
  seekTo(seconds: number): void | boolean | Promise<void | boolean>
  seekBy(seconds: number): void | boolean | Promise<void | boolean>
}

export interface PlayerMediaSession {
  setTrack(track: Track | null): void
  setPlaybackState(state: AudioEngineState): void
  setPositionState(duration: number, position: number): void
  dispose(): void
}

type MediaMetadataConstructor = new (init?: MediaMetadataInit) => MediaMetadata

export interface BrowserMediaSessionEnvironment {
  readonly mediaSession?: MediaSession
  readonly MediaMetadata?: MediaMetadataConstructor
}

function defaultEnvironment(): BrowserMediaSessionEnvironment {
  return {
    ...(typeof navigator === 'undefined' ? {} : { mediaSession: navigator.mediaSession }),
    ...(typeof globalThis.MediaMetadata === 'undefined'
      ? {}
      : { MediaMetadata: globalThis.MediaMetadata }),
  }
}

function run(action: () => void | boolean | Promise<void | boolean>): void {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // Media-key actions must never surface as unhandled browser callbacks.
  }
}

const MEDIA_SESSION_ARTWORK_SIZE = 512

function artworkUrl(url: string): string {
  const size = MEDIA_SESSION_ARTWORK_SIZE
  return coverImageUrl(url, size, size, {
    role: 'media-session',
    exact: true,
    maxWidth: size,
    minWidth: size,
    pixelRatio: 1,
  })
}

function playbackState(state: AudioEngineState): MediaSessionPlaybackState {
  if (state === 'playing') return 'playing'
  if (state === 'ready' || state === 'paused' || state === 'ended') return 'paused'
  return 'none'
}

export function createBrowserMediaSession(
  transport: MediaSessionTransport,
  environment: BrowserMediaSessionEnvironment = defaultEnvironment(),
): PlayerMediaSession {
  const session = environment.mediaSession
  const Metadata = environment.MediaMetadata
  if (session === undefined) {
    return {
      setTrack: () => undefined,
      setPlaybackState: () => undefined,
      setPositionState: () => undefined,
      dispose: () => undefined,
    }
  }
  const activeSession = session

  const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => run(transport.play),
    pause: () => run(transport.pause),
    previoustrack: () => run(transport.previous),
    nexttrack: () => run(transport.next),
    stop: () => run(transport.stop),
    seekto: (details) => {
      if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime)) {
        run(() => transport.seekTo(details.seekTime as number))
      }
    },
    seekbackward: (details) => run(() => transport.seekBy(-(details.seekOffset ?? 10))),
    seekforward: (details) => run(() => transport.seekBy(details.seekOffset ?? 10)),
  }
  const registeredActions: MediaSessionAction[] = []

  for (const [action, handler] of Object.entries(handlers) as [
    MediaSessionAction,
    MediaSessionActionHandler,
  ][]) {
    try {
      activeSession.setActionHandler(action, handler)
      registeredActions.push(action)
    } catch {
      // WebKit exposes Media Session before every action is necessarily supported.
    }
  }

  function clearPositionState(): void {
    try {
      activeSession.setPositionState()
    } catch {
      // Position state is optional on older WebKit builds.
    }
  }

  function clearMetadata(): void {
    try {
      activeSession.metadata = null
    } catch {
      // Metadata is optional and must not affect transport registration.
    }
  }

  return {
    setTrack(track) {
      if (track === null || Metadata === undefined) {
        clearMetadata()
        return
      }
      try {
        // WebKit may keep the previous artwork URL alive while a new
        // MediaMetadata object is assigned. Clearing first gives the native
        // media-session bridge an explicit release point between tracks.
        clearMetadata()
        activeSession.metadata = new Metadata({
          title: track.name,
          artist: track.artists.map(({ name }) => name).join(', '),
          album: track.album.name,
          artwork: track.album.coverUrl
            ? [
                {
                  src: artworkUrl(track.album.coverUrl),
                  sizes: `${MEDIA_SESSION_ARTWORK_SIZE}x${MEDIA_SESSION_ARTWORK_SIZE}`,
                  type: 'image/jpeg',
                },
              ]
            : [],
        })
      } catch {
        clearMetadata()
      }
    },

    setPlaybackState(state) {
      try {
        activeSession.playbackState = playbackState(state)
      } catch {
        // Playback state is advisory and must not affect audio playback.
      }
    },

    setPositionState(duration, position) {
      if (!Number.isFinite(duration) || duration <= 0) {
        clearPositionState()
        return
      }
      const normalizedPosition = Number.isFinite(position)
        ? Math.min(Math.max(position, 0), duration)
        : 0
      try {
        activeSession.setPositionState({
          duration,
          playbackRate: 1,
          position: normalizedPosition,
        })
      } catch {
        clearPositionState()
      }
    },

    dispose() {
      for (const action of registeredActions) {
        try {
          activeSession.setActionHandler(action, null)
        } catch {
          // Ignore actions removed by WebKit during teardown.
        }
      }
      try {
        activeSession.playbackState = 'none'
      } catch {
        // The backing WebView may already be shutting down.
      }
      clearMetadata()
      clearPositionState()
    },
  }
}
