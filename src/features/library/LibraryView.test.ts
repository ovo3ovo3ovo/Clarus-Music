import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NativeCatalogModule from '@/features/catalog/infrastructure/native-catalog'
import LibraryView from './LibraryView.vue'

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  playlistPage: vi.fn(),
  catalogPage: vi.fn(),
  history: vi.fn(),
  createPlaylist: vi.fn(),
  playlistDetail: vi.fn(),
  trackPage: vi.fn(),
  resolveStream: vi.fn(),
  settings: {
    musicQuality: '320000',
  },
}))

vi.mock('./infrastructure/native-library', () => ({
  NativeLibraryGateway: class {
    readonly overview = mocks.overview
    readonly playlistPage = mocks.playlistPage
    readonly catalogPage = mocks.catalogPage
    readonly history = mocks.history
    readonly createPlaylist = mocks.createPlaylist
  },
}))

vi.mock('@/features/playlist/infrastructure/native-playlist', () => ({
  NativePlaylistGateway: class {
    readonly detail = mocks.playlistDetail
    readonly trackPage = mocks.trackPage
  },
}))

vi.mock('@/features/catalog/infrastructure/native-catalog', async (importOriginal) => {
  const original = await importOriginal<typeof NativeCatalogModule>()
  return {
    ...original,
    NativeCatalogGateway: class {
      readonly resolveStream = mocks.resolveStream
    },
  }
})

vi.mock('@/features/auth/application/auth-store', () => ({
  useAuthStore: () => ({
    restoring: false,
    session: {
      authenticated: true,
      user: {
        userId: 9,
        nickname: 'Listener',
        avatarUrl: 'https://img.test/avatar.jpg',
      },
    },
  }),
}))

vi.mock('@/features/settings/application/settings-store', () => ({
  useSettingsStore: () => ({
    settings: mocks.settings,
    update: vi.fn((patch: Record<string, unknown>) => Object.assign(mocks.settings, patch)),
  }),
}))

vi.mock('@/features/player/application/player-store', () => ({
  usePlayerStore: () => ({
    currentTrack: null,
    queueSource: null,
    setQueue: vi.fn(),
    appendQueue: vi.fn(),
    load: vi.fn(),
  }),
}))

const track = {
  id: 11,
  name: 'Track',
  durationMs: 180000,
  artists: [{ id: 7, name: 'Artist' }],
  album: { id: 8, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
  aliases: [],
  translatedNames: [],
  explicit: false,
  playable: true,
  unavailableReason: null,
}

function overview() {
  return {
    likedSongs: {
      id: 1,
      name: 'Liked Songs',
      coverUrl: 'https://img.test/liked.jpg',
      creator: { userId: 9, name: 'Listener' },
      updateTime: 1,
      trackCount: 1,
      description: '',
      private: false,
      subscribed: false,
      trackIds: [11],
      tracks: [track],
      nextOffset: 1,
      hasMore: false,
    },
    playlists: {
      items: [
        {
          kind: 'playlist',
          id: 1,
          name: 'Liked Songs',
          coverUrl: 'https://img.test/liked.jpg',
          creatorId: 9,
          creatorName: 'Listener',
          trackCount: 1,
        },
      ],
      nextOffset: 1,
      hasMore: false,
    },
  }
}

async function flushView(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('LibraryView', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('uses route-driven collection pages and cancels a superseded catalog request', async () => {
    let albumSignal: AbortSignal | undefined
    mocks.overview.mockResolvedValue(overview())
    mocks.catalogPage.mockImplementation(
      async (section: string, _offset: number, signal?: AbortSignal) => {
        if (section === 'albums') {
          albumSignal = signal
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Tab changed', 'AbortError')),
              { once: true },
            )
          })
        }
        return { section, items: [], nextOffset: 0, hasMore: false }
      },
    )

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/library/created',
          component: LibraryView,
          props: {
            section: 'playlists',
            playlistFilter: 'mine',
            titleKey: 'library.createdPlaylists',
          },
        },
        {
          path: '/library/albums',
          component: LibraryView,
          props: { section: 'albums', titleKey: 'library.savedAlbums' },
        },
        {
          path: '/library/artists',
          component: LibraryView,
          props: { section: 'artists', titleKey: 'library.artists' },
        },
      ],
    })
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: {
        en: {
          library: {
            likedSongs: 'Liked Songs',
            createdPlaylists: 'Created Playlists',
            savedPlaylists: 'Saved Playlists',
            savedAlbums: 'Saved Albums',
            songs: 'songs',
            sections: 'Sections',
            albums: 'Albums',
            artists: 'Artists',
            playHistory: 'History',
            allPlaylists: 'All Playlists',
            minePlaylists: 'My Playlists',
            likedPlaylists: 'Saved Playlists',
            newPlaylist: 'New Playlist',
            empty: 'Empty',
          },
          search: { playTrack: 'Play' },
          playlist: { play: 'Play playlist' },
        },
      },
    })
    await router.push('/library/created')
    await router.isReady()
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      components: { RouterView },
      template: '<RouterView />',
    })
      .use(router)
      .use(i18n)
    app.mount(root)
    await flushView()

    expect(root.querySelector('.library-page-header h1')?.textContent).toBe('Created Playlists')
    expect(root.querySelector('.liked-card')).toBeNull()
    expect(root.querySelector('.library-personal-cards')).toBeNull()
    expect(root.querySelector('.tabs')).toBeNull()
    expect(mocks.catalogPage).not.toHaveBeenCalled()

    await router.push('/library/albums')
    await flushView()
    expect(mocks.catalogPage).toHaveBeenCalledWith('albums', 0, expect.any(AbortSignal))

    await router.push('/library/artists')
    await flushView()
    expect(albumSignal?.aborted).toBe(true)
    expect(mocks.catalogPage).toHaveBeenCalledWith('artists', 0, expect.any(AbortSignal))

    app.unmount()
  })
})
