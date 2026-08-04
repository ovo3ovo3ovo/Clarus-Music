import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { usePlayerStore } from '@/features/player/application/player-store'
import type { LyricMode, TrackLyrics } from '../domain/lyrics'
import { hasRomanization, hasTranslation } from '../domain/lyrics'
import { NativeLyricsGateway, type LyricsGateway } from '../infrastructure/native-lyrics'

interface LyricsPlayer {
  readonly currentTrack: Readonly<{ id: number }> | null
  readonly pendingTrack?: Readonly<{ id: number }> | null
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function availableLyricMode(
  lyrics: TrackLyrics,
  preferred: LyricMode = 'translation',
): LyricMode {
  if (preferred === 'translation' && hasTranslation(lyrics)) return preferred
  if (preferred === 'romanization' && hasRomanization(lyrics)) return preferred
  if (hasTranslation(lyrics)) return 'translation'
  return 'romanization'
}

export function createLyricsStore(
  gateway: LyricsGateway = new NativeLyricsGateway(),
  storeId = 'lyrics',
  playerStore?: LyricsPlayer,
) {
  return defineStore(storeId, () => {
    const player = playerStore ?? usePlayerStore()
    const visible = ref(false)
    const loading = ref(false)
    const error = shallowRef<string | null>(null)
    const lyrics = shallowRef<TrackLyrics | null>(null)
    const mode = ref<LyricMode>('translation')
    let controller: AbortController | null = null

    function displayedTrackId(): number | null {
      return player.pendingTrack?.id ?? player.currentTrack?.id ?? null
    }

    function cancel(reason: string): void {
      controller?.abort(reason)
      controller = null
      loading.value = false
    }

    async function load(trackId: number): Promise<void> {
      cancel('Lyrics request superseded')
      const request = new AbortController()
      controller = request
      loading.value = true
      error.value = null
      lyrics.value = null
      try {
        const result = await gateway.load(trackId, request.signal)
        if (controller !== request || displayedTrackId() !== trackId) return
        lyrics.value = result
        mode.value = availableLyricMode(result, mode.value)
      } catch (reason) {
        if (controller === request && !isAbort(reason)) error.value = errorMessage(reason)
      } finally {
        if (controller === request) {
          controller = null
          loading.value = false
        }
      }
    }

    function open(): void {
      visible.value = true
    }

    function close(): void {
      visible.value = false
    }

    function toggle(): void {
      visible.value = !visible.value
    }

    function switchMode(nextMode: LyricMode): void {
      mode.value = lyrics.value === null ? nextMode : availableLyricMode(lyrics.value, nextMode)
    }

    function dispose(): void {
      cancel('Lyrics store disposed')
      visible.value = false
      lyrics.value = null
      error.value = null
    }

    watch(
      displayedTrackId,
      (trackId) => {
        if (trackId === null) {
          cancel('No current track')
          lyrics.value = null
          error.value = null
          return
        }
        void load(trackId)
      },
      { immediate: true },
    )
    onScopeDispose(dispose)

    return { visible, loading, error, lyrics, mode, open, close, toggle, switchMode, dispose }
  })
}

export const useLyricsStore = createLyricsStore()
