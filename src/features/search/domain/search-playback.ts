import type { Track } from '@/types/music'

export interface SearchPlaybackSelection {
  readonly queue: readonly Track[]
  readonly index: number
  readonly track: Track
}

export function selectSearchTrack(
  tracks: readonly Track[],
  selectedTrackId: number,
): SearchPlaybackSelection | null {
  const queue = tracks.filter((track) => track.playable)
  const index = queue.findIndex((track) => track.id === selectedTrackId)
  if (index < 0) return null
  const track = queue[index]
  return track === undefined ? null : { queue, index, track }
}
