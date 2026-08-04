import type { Track } from '@/types/music'

export interface DailySongs {
  readonly tracks: readonly Track[]
}

export interface DailySongSelection {
  readonly queue: readonly Track[]
  readonly index: number
  readonly track: Track
}

export function selectDailySong(
  tracks: readonly Track[],
  selectedTrackId?: number,
): DailySongSelection | null {
  const queue = tracks.filter((track) => track.playable)
  const index =
    selectedTrackId === undefined ? 0 : queue.findIndex(({ id }) => id === selectedTrackId)
  const track = queue[index]
  return track === undefined ? null : { queue, index, track }
}
