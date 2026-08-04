import type { AlbumCard, ArtistCard, PlaylistCard } from '@/features/catalog/domain/catalog'
import type { PlaylistDetail } from '@/features/playlist/domain/playlist'
import type { Track } from '@/types/music'

export type LibraryCatalogSection = 'albums' | 'artists'
export type LibraryHistoryPeriod = 'week' | 'all'
export type LibraryPlaylistFilter = 'all' | 'mine' | 'liked'

export interface LibraryPlaylist extends PlaylistCard {
  readonly creatorId: number
}

export interface LibraryPageMetadata {
  readonly nextOffset: number
  readonly hasMore: boolean
}

export interface LibraryPlaylistPage extends LibraryPageMetadata {
  readonly items: readonly LibraryPlaylist[]
}

export interface LibraryOverview {
  readonly likedSongs: PlaylistDetail
  readonly playlists: LibraryPlaylistPage
}

export type LibraryCatalogPage =
  | (LibraryPageMetadata & { readonly section: 'albums'; readonly items: readonly AlbumCard[] })
  | (LibraryPageMetadata & { readonly section: 'artists'; readonly items: readonly ArtistCard[] })

export interface LibraryHistoryItem {
  readonly track: Track
  readonly playCount: number
}

export interface LibraryHistory {
  readonly period: LibraryHistoryPeriod
  readonly items: readonly LibraryHistoryItem[]
}

export function appendUniqueItems<T extends { readonly id: number }>(
  current: readonly T[],
  additions: readonly T[],
): readonly T[] {
  const seen = new Set(current.map(({ id }) => id))
  const merged = [...current]
  for (const item of additions) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}

export function filterLibraryPlaylists(
  playlists: readonly LibraryPlaylist[],
  filter: LibraryPlaylistFilter,
  userId: number,
  likedPlaylistId: number,
): readonly LibraryPlaylist[] {
  return playlists.filter((playlist) => {
    if (playlist.id === likedPlaylistId) return false
    if (filter === 'mine') return playlist.creatorId === userId
    if (filter === 'liked') return playlist.creatorId !== userId
    return true
  })
}
