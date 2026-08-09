import { emitTo } from '@tauri-apps/api/event'
import type { Track } from '@/types/music'
import { initialDetailSurfaceRoute } from './detail-surface'

export const DETAIL_PLAY_EVENT = 'clarus-detail-play'
export const DETAIL_APPEND_QUEUE_EVENT = 'clarus-detail-append-queue'

export interface DetailPlayPayload {
  readonly queue: readonly Track[]
  readonly index: number
  readonly source: string | null
  readonly track: Track
  readonly autoplay: boolean
}

export interface DetailAppendQueuePayload {
  readonly tracks: readonly Track[]
  readonly source: string
}

export function isDetailPlaybackClient(): boolean {
  return initialDetailSurfaceRoute() !== null
}

export async function requestMainDetailPlayback(payload: DetailPlayPayload): Promise<void> {
  await emitTo('main', DETAIL_PLAY_EVENT, payload)
}

export function appendMainDetailQueue(tracks: readonly Track[], source: string): void {
  void emitTo<DetailAppendQueuePayload>('main', DETAIL_APPEND_QUEUE_EVENT, { tracks, source })
}
