import type { Track } from '@/types/music'

export const PLAYLIST_PAGE_SIZE = 100

export interface PlaylistCreator {
  readonly userId: number
  readonly name: string
}

export interface PlaylistDetail {
  readonly id: number
  readonly name: string
  readonly coverUrl: string
  readonly creator: PlaylistCreator
  readonly updateTime: number
  readonly trackCount: number
  readonly description: string
  readonly private: boolean
  readonly subscribed: boolean
  readonly trackIds: readonly number[]
  readonly tracks: readonly Track[]
  readonly nextOffset: number
  readonly hasMore: boolean
}

export interface PlaylistTrackPage {
  readonly tracks: readonly Track[]
  readonly requestedCount: number
}

export interface AppendedPlaylistTracks {
  readonly tracks: readonly Track[]
  readonly nextOffset: number
  readonly hasMore: boolean
}

export function appendPlaylistTrackPage(
  currentTracks: readonly Track[],
  currentOffset: number,
  totalTrackIds: number,
  page: PlaylistTrackPage,
): AppendedPlaylistTracks {
  if (
    !Number.isSafeInteger(currentOffset) ||
    currentOffset < 0 ||
    !Number.isSafeInteger(totalTrackIds) ||
    totalTrackIds < currentOffset ||
    !Number.isSafeInteger(page.requestedCount) ||
    page.requestedCount < 1 ||
    page.requestedCount > PLAYLIST_PAGE_SIZE ||
    currentOffset + page.requestedCount > totalTrackIds
  ) {
    throw new Error('Invalid playlist pagination metadata')
  }

  const seen = new Set(currentTracks.map(({ id }) => id))
  const tracks = [...currentTracks]
  for (const track of page.tracks) {
    if (!seen.has(track.id)) {
      seen.add(track.id)
      tracks.push(track)
    }
  }
  const nextOffset = currentOffset + page.requestedCount
  return { tracks, nextOffset, hasMore: nextOffset < totalTrackIds }
}

export function filterPlaylistTracks(tracks: readonly Track[], keywords: string): readonly Track[] {
  const normalized = keywords.trim().toLocaleLowerCase()
  if (normalized.length === 0) return tracks
  return tracks.filter((track) =>
    [track.name, track.album.name, ...track.aliases, ...track.artists.map(({ name }) => name)].some(
      (field) => field.toLocaleLowerCase().includes(normalized),
    ),
  )
}

export function selectPlaylistTrack(
  tracks: readonly Track[],
  selectedTrackId?: number,
): { readonly queue: readonly Track[]; readonly index: number; readonly track: Track } | null {
  const queue = tracks.filter((track) => track.playable)
  const index =
    selectedTrackId === undefined ? 0 : queue.findIndex(({ id }) => id === selectedTrackId)
  const track = queue[index]
  return track === undefined ? null : { queue, index, track }
}
