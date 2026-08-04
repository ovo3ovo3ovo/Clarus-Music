import type { SearchResultPage, SearchType } from '@/features/catalog/domain/catalog'

const routeAliases: Readonly<Record<string, SearchType>> = {
  tracks: 'tracks',
  artists: 'artists',
  albums: 'albums',
  playlists: 'playlists',
  musicVideos: 'musicVideos',
  'music-videos': 'musicVideos',
}

export function parseSearchType(value: unknown): SearchType | null {
  return typeof value === 'string' ? (routeAliases[value] ?? null) : null
}

export function searchTypeRouteSegment(searchType: SearchType): string {
  return searchType === 'musicVideos' ? 'music-videos' : searchType
}

function mergeById<T extends { readonly id: number }>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  if (existing.length === 0) return incoming
  const seen = new Set(existing.map(({ id }) => id))
  const appended = incoming.filter(({ id }) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  return appended.length === 0 ? existing : [...existing, ...appended]
}

export function appendSearchPage(
  existing: SearchResultPage | null,
  incoming: SearchResultPage,
): SearchResultPage {
  if (existing === null || existing.searchType !== incoming.searchType) return incoming

  switch (incoming.searchType) {
    case 'tracks':
      return {
        ...incoming,
        items: mergeById(existing.searchType === 'tracks' ? existing.items : [], incoming.items),
      }
    case 'artists':
      return {
        ...incoming,
        items: mergeById(existing.searchType === 'artists' ? existing.items : [], incoming.items),
      }
    case 'albums':
      return {
        ...incoming,
        items: mergeById(existing.searchType === 'albums' ? existing.items : [], incoming.items),
      }
    case 'playlists':
      return {
        ...incoming,
        items: mergeById(existing.searchType === 'playlists' ? existing.items : [], incoming.items),
      }
    case 'musicVideos':
      return {
        ...incoming,
        items: mergeById(
          existing.searchType === 'musicVideos' ? existing.items : [],
          incoming.items,
        ),
      }
  }
}
