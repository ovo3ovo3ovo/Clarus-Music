import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Pinia } from 'pinia'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import { usePlayerStore } from '@/features/player/application/player-store'
import { releaseAudioSource } from '@/features/player/domain/audio-engine'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import type { Track } from '@/types/music'
import {
  DETAIL_APPEND_QUEUE_EVENT,
  DETAIL_PLAY_EVENT,
  type DetailAppendQueuePayload,
  type DetailPlayPayload,
} from './detail-playback'

function isTrack(value: unknown): value is Track {
  if (value === null || typeof value !== 'object') return false
  const track = value as Partial<Track>
  return Number.isSafeInteger(track.id) && Number(track.id) > 0 && typeof track.name === 'string'
}

function parsePlayPayload(value: unknown): DetailPlayPayload | null {
  if (value === null || typeof value !== 'object') return null
  const payload = value as Partial<DetailPlayPayload>
  if (
    !Array.isArray(payload.queue) ||
    payload.queue.length > 10_000 ||
    !payload.queue.every(isTrack) ||
    !Number.isSafeInteger(payload.index) ||
    Number(payload.index) < 0 ||
    Number(payload.index) >= payload.queue.length ||
    !isTrack(payload.track) ||
    (payload.source !== null && typeof payload.source !== 'string') ||
    typeof payload.autoplay !== 'boolean'
  ) {
    return null
  }
  return payload as DetailPlayPayload
}

function parseAppendPayload(value: unknown): DetailAppendQueuePayload | null {
  if (value === null || typeof value !== 'object') return null
  const payload = value as Partial<DetailAppendQueuePayload>
  if (
    !Array.isArray(payload.tracks) ||
    payload.tracks.length > 10_000 ||
    !payload.tracks.every(isTrack) ||
    typeof payload.source !== 'string'
  ) {
    return null
  }
  return payload as DetailAppendQueuePayload
}

export async function installMainDetailPlayback(pinia: Pinia): Promise<() => void> {
  const player = usePlayerStore(pinia)
  const settings = useSettingsStore(pinia)
  const catalog = new NativeCatalogGateway()
  const unlisteners: UnlistenFn[] = []
  let controller: AbortController | null = null

  unlisteners.push(
    await listen<unknown>(DETAIL_PLAY_EVENT, (event) => {
      const payload = parsePlayPayload(event.payload)
      if (payload === null) return
      controller?.abort('Detail playback superseded')
      const current = new AbortController()
      controller = current
      void (async () => {
        let source = null
        try {
          source = await catalog.resolveStream(
            payload.track.id,
            settings.settings.musicQuality,
            current.signal,
          )
          if (controller !== current) {
            releaseAudioSource(source)
            return
          }
          player.setQueue(payload.queue, payload.index, payload.source)
          await player.load(payload.track, source, payload.autoplay, current.signal)
          source = null
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            globalThis.console.error('Failed to start detail playback', error)
          }
        } finally {
          if (source !== null) releaseAudioSource(source)
          if (controller === current) controller = null
        }
      })()
    }),
  )
  unlisteners.push(
    await listen<unknown>(DETAIL_APPEND_QUEUE_EVENT, (event) => {
      const payload = parseAppendPayload(event.payload)
      if (payload !== null) player.appendQueue(payload.tracks, payload.source)
    }),
  )

  return () => {
    controller?.abort('Detail playback bridge disposed')
    controller = null
    for (const unlisten of unlisteners) unlisten()
  }
}
