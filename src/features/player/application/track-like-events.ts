import type { Track } from '@/types/music'

export interface TrackLikeChange {
  readonly track: Track
  readonly liked: boolean
}

type TrackLikeListener = (change: TrackLikeChange) => void

const listeners = new Set<TrackLikeListener>()

/**
 * All song-heart entry points publish the confirmed NetEase result here.
 * This keeps the player, lyrics, context menu, and Liked Songs route in sync
 * without treating local UI state as a second source of truth.
 */
export function emitTrackLikeChange(change: TrackLikeChange): void {
  for (const listener of listeners) listener(change)
}

export function onTrackLikeChange(listener: TrackLikeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
