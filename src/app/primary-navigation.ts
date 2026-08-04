import type { RouteRecordName } from 'vue-router'

const primaryRouteNames = new Set<RouteRecordName>([
  'likedSongs',
  'dailySongs',
  'createdPlaylists',
  'savedPlaylists',
  'savedAlbums',
  'libraryArtists',
  'playHistory',
  'search',
])

export function isPrimaryNavigationRoute(name: RouteRecordName | null | undefined): boolean {
  return name !== null && name !== undefined && primaryRouteNames.has(name)
}
