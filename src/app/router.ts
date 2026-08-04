import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { parseSearchType } from '@/features/search/domain/typed-search'
import { parsePositiveIntegerRouteParam } from './route-params'

const routes: readonly RouteRecordRaw[] = [
  { path: '/', redirect: '/daily/songs' },
  { path: '/home', redirect: '/daily/songs' },
  { path: '/library', redirect: '/library/liked-songs' },
  {
    path: '/library/liked-songs',
    name: 'likedSongs',
    component: () => import('@/features/playlist/PlaylistView.vue'),
    meta: { keepAlive: true, cacheKey: 'liked-songs' },
  },
  {
    path: '/library/created-playlists',
    name: 'createdPlaylists',
    component: () => import('@/features/library/LibraryView.vue'),
    props: { section: 'playlists', playlistFilter: 'mine', titleKey: 'library.createdPlaylists' },
    meta: { keepAlive: true, cacheKey: 'library' },
  },
  {
    path: '/library/saved-playlists',
    name: 'savedPlaylists',
    component: () => import('@/features/library/LibraryView.vue'),
    props: { section: 'playlists', playlistFilter: 'liked', titleKey: 'library.savedPlaylists' },
    meta: { keepAlive: true, cacheKey: 'library' },
  },
  {
    path: '/library/albums',
    name: 'savedAlbums',
    component: () => import('@/features/library/LibraryView.vue'),
    props: { section: 'albums', titleKey: 'library.savedAlbums' },
    meta: { keepAlive: true, cacheKey: 'library' },
  },
  {
    path: '/library/artists',
    name: 'libraryArtists',
    component: () => import('@/features/library/LibraryView.vue'),
    props: { section: 'artists', titleKey: 'library.artists' },
    meta: { keepAlive: true, cacheKey: 'library' },
  },
  {
    path: '/library/history',
    name: 'playHistory',
    component: () => import('@/features/library/LibraryView.vue'),
    props: { section: 'history', titleKey: 'library.playHistory' },
    meta: { keepAlive: true, cacheKey: 'library' },
  },
  {
    path: '/playlist/:id',
    name: 'playlist',
    component: () => import('@/features/playlist/PlaylistView.vue'),
    beforeEnter: (to) =>
      parsePositiveIntegerRouteParam(to.params.id) ? true : { path: '/library', replace: true },
  },
  {
    path: '/album/:id',
    name: 'album',
    component: () => import('@/features/album/AlbumView.vue'),
    beforeEnter: (to) =>
      parsePositiveIntegerRouteParam(to.params.id) ? true : { path: '/library', replace: true },
  },
  {
    path: '/artist/:id',
    name: 'artist',
    component: () => import('@/features/artist/ArtistView.vue'),
    beforeEnter: (to) =>
      parsePositiveIntegerRouteParam(to.params.id) ? true : { path: '/library', replace: true },
  },
  {
    path: '/artist/:id/mv',
    name: 'artistMV',
    component: () => import('@/features/artist/ArtistMvView.vue'),
    beforeEnter: (to) =>
      parsePositiveIntegerRouteParam(to.params.id) ? true : { path: '/library', replace: true },
  },
  {
    path: '/mv/:id',
    name: 'mv',
    component: () => import('@/features/music-video/MusicVideoView.vue'),
    beforeEnter: (to) =>
      parsePositiveIntegerRouteParam(to.params.id) ? true : { path: '/library', replace: true },
  },
  {
    path: '/next',
    name: 'next',
    component: () => import('@/features/player/NextQueueView.vue'),
  },
  {
    path: '/search/:keywords?',
    name: 'search',
    component: () => import('@/features/search/SearchView.vue'),
  },
  {
    path: '/search/:keywords/:type',
    name: 'searchType',
    component: () => import('@/features/search/TypedSearchView.vue'),
    beforeEnter: (to) => {
      if (parseSearchType(to.params.type)) return true
      const keywords = encodeURIComponent(String(to.params.keywords ?? ''))
      return { path: keywords.length > 0 ? `/search/${keywords}` : '/search', replace: true }
    },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/features/settings/SettingsView.vue'),
  },
  {
    path: '/daily/songs',
    name: 'dailySongs',
    component: () => import('@/features/daily-songs/DailySongsView.vue'),
    meta: { keepAlive: true, cacheKey: 'daily-songs' },
  },
  { path: '/login', name: 'login', redirect: '/login/account' },
  {
    path: '/login/account',
    name: 'loginAccount',
    component: () => import('@/features/auth/LoginAccountView.vue'),
  },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [...routes],
})

/** Warm the destinations exposed by the persistent sidebar after first paint. */
export function preloadPrimaryViews(): void {
  const loaders = [
    () => import('@/features/daily-songs/DailySongsView.vue'),
    () => import('@/features/playlist/PlaylistView.vue'),
    () => import('@/features/library/LibraryView.vue'),
    () => import('@/features/settings/SettingsView.vue'),
  ]
  for (const load of loaders) void load().catch(() => undefined)
}
