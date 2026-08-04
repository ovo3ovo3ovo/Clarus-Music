import type { MusicQuality } from '@/features/settings/domain/settings'
import type { AudioSource } from '@/features/player/domain/audio-engine'
import type { Track } from '@/types/music'

export interface ArtistCard {
  readonly kind: 'artist'
  readonly id: number
  readonly name: string
  readonly coverUrl: string
  readonly description: string
}

export interface AlbumCard {
  readonly kind: 'album'
  readonly id: number
  readonly name: string
  readonly coverUrl: string
  readonly artistId: number
  readonly artistName: string
}

export interface PlaylistCard {
  readonly kind: 'playlist'
  readonly id: number
  readonly name: string
  readonly coverUrl: string
  readonly creatorName: string
  readonly trackCount: number
}

export interface MusicVideoCard {
  readonly kind: 'musicVideo'
  readonly id: number
  readonly name: string
  readonly coverUrl: string
  readonly artistId: number
  readonly artistName: string
  readonly durationMs: number
}

export type CatalogCoverCard = ArtistCard | AlbumCard | PlaylistCard
export type SearchType = 'tracks' | 'artists' | 'albums' | 'playlists' | 'musicVideos'

export interface SearchSection<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly error: string | null
}

export interface SearchOverview {
  readonly tracks: SearchSection<Track>
  readonly artists: SearchSection<ArtistCard>
  readonly albums: SearchSection<AlbumCard>
  readonly playlists: SearchSection<PlaylistCard>
  readonly musicVideos: SearchSection<MusicVideoCard>
}

interface SearchPageMetadata {
  readonly total: number
  readonly nextOffset: number
  readonly hasMore: boolean
}

export type SearchResultPage =
  | (SearchPageMetadata & { readonly searchType: 'tracks'; readonly items: readonly Track[] })
  | (SearchPageMetadata & { readonly searchType: 'artists'; readonly items: readonly ArtistCard[] })
  | (SearchPageMetadata & { readonly searchType: 'albums'; readonly items: readonly AlbumCard[] })
  | (SearchPageMetadata & {
      readonly searchType: 'playlists'
      readonly items: readonly PlaylistCard[]
    })
  | (SearchPageMetadata & {
      readonly searchType: 'musicVideos'
      readonly items: readonly MusicVideoCard[]
    })

export interface CatalogGateway {
  searchOverview(keywords: string, signal?: AbortSignal): Promise<SearchOverview>
  searchPage(
    searchType: SearchType,
    keywords: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<SearchResultPage>
  resolveStream(trackId: number, quality: MusicQuality, signal?: AbortSignal): Promise<AudioSource>
}
