export type TrackId = number
export type AlbumId = number
export type ArtistId = number
export type PlaylistId = number

export interface Artist {
  readonly id: ArtistId
  readonly name: string
}

export interface AlbumSummary {
  readonly id: AlbumId
  readonly name: string
  readonly coverUrl: string
}

export interface Track {
  readonly id: TrackId
  readonly name: string
  readonly durationMs: number
  readonly artists: readonly Artist[]
  readonly album: AlbumSummary
  readonly aliases: readonly string[]
  readonly translatedNames: readonly string[]
  readonly explicit: boolean
  readonly playable: boolean
  readonly unavailableReason: string | null
}

export interface PlaylistSummary {
  readonly id: PlaylistId
  readonly name: string
  readonly coverUrl: string
  readonly creatorName: string
  readonly trackCount: number
}

export type RepeatMode = 'off' | 'all' | 'one'

export function formatArtists(artists: readonly Artist[]): string {
  return artists.map(({ name }) => name).join(', ')
}
