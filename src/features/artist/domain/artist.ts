import type { Track } from '@/types/music'

export interface ArtistIdentity {
  readonly id: number
  readonly name: string
  readonly coverUrl: string
}

export interface ArtistProfile extends ArtistIdentity {
  readonly briefDescription: string
  readonly musicCount: number
  readonly albumCount: number
  readonly videoCount: number
  readonly followed: boolean
}

export interface ArtistAlbum {
  readonly id: number
  readonly artistId: number
  readonly name: string
  readonly coverUrl: string
  readonly publishTime: number
  readonly albumType: string
  readonly trackCount: number
  readonly explicit: boolean
}

export interface ArtistVideo {
  readonly id: number
  readonly artistId: number
  readonly name: string
  readonly coverUrl: string
  readonly publishTime: string
}

export interface ArtistDetail {
  readonly artist: ArtistProfile
  readonly popularTracks: readonly Track[]
  readonly latestRelease: ArtistAlbum | null
  readonly albums: readonly ArtistAlbum[]
  readonly eps: readonly ArtistAlbum[]
  readonly videos: readonly ArtistVideo[]
  readonly videosHasMore: boolean
  readonly similarArtists: readonly ArtistIdentity[]
}

export interface ArtistVideoPage {
  readonly items: readonly ArtistVideo[]
  readonly nextOffset: number
  readonly hasMore: boolean
}

export interface ArtistTrackSelection {
  readonly queue: readonly Track[]
  readonly index: number
  readonly track: Track
}

export function formatArtistAlbumType(album: ArtistAlbum): string {
  if (album.albumType === 'EP/Single') return album.trackCount === 1 ? 'Single' : 'EP'
  if (album.albumType === '专辑') return 'Album'
  return album.albumType || 'Album'
}

export function selectArtistTrack(
  tracks: readonly Track[],
  selectedTrackId?: number,
): ArtistTrackSelection | null {
  const queue = tracks.filter((track) => track.playable)
  const index =
    selectedTrackId === undefined ? 0 : queue.findIndex(({ id }) => id === selectedTrackId)
  const track = queue[index]
  return track === undefined ? null : { queue, index, track }
}

export function mergeArtistVideos(
  existing: readonly ArtistVideo[],
  page: ArtistVideoPage,
): readonly ArtistVideo[] {
  const byId = new Map(existing.map((video) => [video.id, video]))
  for (const video of page.items) byId.set(video.id, video)
  return [...byId.values()]
}
