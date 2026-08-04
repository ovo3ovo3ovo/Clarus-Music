import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppNavbar from './AppNavbar.vue'

interface MockUser {
  readonly nickname: string
  readonly avatarUrl: string
}

const mocks = vi.hoisted(() => ({
  auth: {
    session: { user: null as MockUser | null },
  },
}))

vi.mock('@/features/auth/application/auth-store', () => ({ useAuthStore: () => mocks.auth }))

const messages = {
  en: {
    nav: {
      library: 'Library',
      favorites: 'Favorites',
      dailySongs: 'Daily Recommendations',
      createdPlaylists: 'Created Playlists',
      savedPlaylists: 'Saved Playlists',
      savedAlbums: 'Saved Albums',
      artists: 'Artists',
      playHistory: 'Play History',
      search: 'Search',
      searchPlaceholder: 'Search music',
      back: 'Back',
      settings: 'Settings',
      login: 'Log in',
      resizeSidebar: 'Resize sidebar',
    },
    accountMenu: {
      settings: 'Settings',
    },
  },
}

async function mountNavbar(path = '/') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/daily/songs' },
      {
        path: '/library/liked-songs',
        name: 'likedSongs',
        component: { template: '<p>Favorites</p>' },
      },
      {
        path: '/daily/songs',
        name: 'dailySongs',
        component: { template: '<p>Daily</p>' },
      },
      {
        path: '/library/created-playlists',
        name: 'createdPlaylists',
        component: { template: '<p>Created</p>' },
      },
      {
        path: '/library/saved-playlists',
        name: 'savedPlaylists',
        component: { template: '<p>Saved</p>' },
      },
      {
        path: '/library/albums',
        name: 'savedAlbums',
        component: { template: '<p>Albums</p>' },
      },
      {
        path: '/library/artists',
        name: 'libraryArtists',
        component: { template: '<p>Artists</p>' },
      },
      {
        path: '/library/history',
        name: 'playHistory',
        component: { template: '<p>History</p>' },
      },
      { path: '/playlist/:id', name: 'playlist', component: { template: '<p>Playlist</p>' } },
      { path: '/settings', component: { template: '<p>Settings</p>' } },
      { path: '/search/:keywords?', name: 'search', component: { template: '<p>Search</p>' } },
    ],
  })
  const i18n = createI18n({ legacy: false, locale: 'en', messages })
  await router.push(path)
  await router.isReady()
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(AppNavbar).use(router).use(i18n)
  app.mount(root)
  await nextTick()
  return { app, root, router }
}

describe('AppNavbar navigation', () => {
  beforeEach(() => {
    mocks.auth.session.user = null
    const storedValues = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => storedValues.set(key, value),
      removeItem: (key: string) => storedValues.delete(key),
      clear: () => storedValues.clear(),
    })
    document.documentElement.style.removeProperty('--sidebar-width')
    document.documentElement.classList.remove('sidebar-resizing')
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens settings directly from the account entry without a popup menu', async () => {
    mocks.auth.session.user = { nickname: 'Ada', avatarUrl: 'https://img.test/ada.jpg' }
    const { app, root, router } = await mountNavbar()

    expect(root.querySelector('[role="menu"]')).toBeNull()
    expect(root.querySelector('.account-chevron')).toBeNull()
    root.querySelector<HTMLButtonElement>('.account-trigger')?.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/settings'))
    expect(root.querySelector('[role="menu"]')).toBeNull()
    expect(root.textContent).not.toContain('GitHub repository')
    app.unmount()
  })

  it('keeps an editable search field directly below play history', async () => {
    const { app, root, router } = await mountNavbar()

    const labels = [...root.querySelectorAll('.navigation-links a > span:not(.app-icon)')].map(
      (item) => item.textContent?.trim(),
    )
    expect(labels).toEqual([
      'Favorites',
      'Daily Recommendations',
      'Created Playlists',
      'Saved Playlists',
      'Saved Albums',
      'Artists',
      'Play History',
    ])
    expect(root.querySelector('.navbar-brand')).toBeNull()
    expect(root.querySelector('.navigation-label')).toBeNull()
    const search = root.querySelector<HTMLInputElement>('.sidebar-search input')
    expect(search).not.toBeNull()
    expect(search?.type).toBe('search')
    expect(search?.placeholder).toBe('Search music')
    const navigationLinks = root.querySelectorAll<HTMLAnchorElement>('.navigation-links a')
    expect(navigationLinks[navigationLinks.length - 1]?.getAttribute('href')).toBe(
      '/library/history',
    )

    search!.value = 'Mojave'
    search!.dispatchEvent(new Event('input', { bubbles: true }))
    root
      .querySelector<HTMLFormElement>('.sidebar-search')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/search/Mojave'))

    expect(root.querySelector('.content-back-button')).toBeNull()
    app.unmount()
  })

  it('uses one content back button only on detail pages', async () => {
    const { app, root, router } = await mountNavbar('/playlist/1')

    expect(root.querySelectorAll('.content-back-button')).toHaveLength(1)
    expect(root.querySelector('.settings-link')).toBeNull()
    expect(root.querySelector('.history-controls')).toBeNull()
    expect(root.querySelector('[aria-label="Forward"]')).toBeNull()

    root.querySelector<HTMLButtonElement>('.content-back-button')?.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/daily/songs'))
    app.unmount()
  })

  it('resizes the sidebar smoothly from its separator and persists the chosen width', async () => {
    const { app, root } = await mountNavbar()
    const separator = root.querySelector<HTMLElement>('[role="separator"]')!

    separator.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7 }),
    )
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 260, pointerId: 7 }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 20))

    expect(document.documentElement.classList).toContain('sidebar-resizing')
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('260px')

    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }))
    expect(document.documentElement.classList).not.toContain('sidebar-resizing')
    expect(localStorage.getItem('clarus-music.sidebar-width')).toBe('260')
    app.unmount()
  })
})
