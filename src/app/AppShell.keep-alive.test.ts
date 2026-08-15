import { createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted } from 'vue'
import { createMemoryHistory, createRouter, useRoute } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  router: null as ReturnType<typeof createRouter> | null,
  mounted: { artist: 0, daily: 0, liked: 0 },
  unmounted: { artist: 0, daily: 0, liked: 0 },
}))

vi.mock('./router', () => ({
  get router() {
    return state.router
  },
}))

vi.mock('./route-scroll', () => ({
  installRouteScrollManager: vi.fn(() => () => undefined),
}))

vi.mock('./primary-navigation', () => ({
  isPrimaryNavigationRoute: vi.fn(() => true),
}))

vi.mock('@/components/layout/AppNavbar.vue', () => ({
  default: { template: '<nav />' },
}))

vi.mock('@/components/common/AppDialogHost.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/features/player/presentation/PlayerBar.vue', () => ({
  default: { template: '<footer />' },
}))

vi.mock('@/app/ToastHost.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/features/lyrics/application/lyrics-store', () => ({
  useLyricsStore: () => ({ visible: false }),
}))

vi.mock('@/features/player/application/player-store', () => ({
  usePlayerStore: () => ({ enabled: false, togglePlayback: vi.fn() }),
}))

vi.mock('@/platform/desktop', () => ({
  desktop: { isDesktop: false },
}))

vi.mock('@/platform/window-drag', () => ({
  installWindowDrag: vi.fn(() => () => undefined),
}))

function routeSurface(kind: 'artist' | 'daily' | 'liked') {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1)
  return defineComponent({
    name: `Test${label}Surface`,
    setup() {
      const route = useRoute()
      onMounted(() => {
        state.mounted[kind] = (state.mounted[kind] ?? 0) + 1
      })
      onBeforeUnmount(() => {
        state.unmounted[kind] = (state.unmounted[kind] ?? 0) + 1
      })
      return () =>
        h('div', {
          'data-surface': kind,
          'data-route-id': String(route.params.id ?? ''),
        })
    },
  })
}

async function flushRouter(): Promise<void> {
  await nextTick()
  await nextTick()
}

describe('AppShell route cache boundaries', () => {
  afterEach(() => {
    document.body.replaceChildren()
    state.router = null
    state.mounted.artist = 0
    state.mounted.daily = 0
    state.mounted.liked = 0
    state.unmounted.artist = 0
    state.unmounted.daily = 0
    state.unmounted.liked = 0
  })

  it('reuses artist/:id in place but destroys the artist tree on exit', async () => {
    const ArtistSurface = routeSurface('artist')
    const DailySurface = routeSurface('daily')
    const LikedSurface = routeSurface('liked')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/artist/:id',
          name: 'artist',
          component: ArtistSurface,
          meta: { keepAlive: true, cacheKey: 'artist' },
        },
        {
          path: '/daily/songs',
          name: 'dailySongs',
          component: DailySurface,
          meta: { keepAlive: true, cacheKey: 'daily-songs' },
        },
        { path: '/library/liked-songs', name: 'likedSongs', component: LikedSurface },
      ],
    })
    state.router = router

    const { default: AppShell } = await import('./AppShell.vue')
    await router.push('/artist/1')
    await router.isReady()
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp(AppShell).use(router)
    app.mount(root)
    await flushRouter()

    expect(state.mounted.artist).toBe(1)
    expect(root.querySelector('[data-surface="artist"]')?.getAttribute('data-route-id')).toBe('1')

    await router.push('/artist/2')
    await flushRouter()
    expect(state.mounted.artist).toBe(1)
    expect(state.unmounted.artist).toBe(0)
    expect(root.querySelector('[data-surface="artist"]')?.getAttribute('data-route-id')).toBe('2')

    await router.push('/daily/songs')
    await flushRouter()
    expect(state.unmounted.artist).toBe(1)
    expect(root.querySelector('[data-surface="daily"]')).not.toBeNull()

    await router.push('/artist/3')
    await flushRouter()
    expect(state.mounted.artist).toBe(2)

    await router.push('/library/liked-songs')
    await flushRouter()
    expect(state.unmounted.artist).toBe(2)
    expect(root.querySelector('[data-surface="liked"]')).not.toBeNull()

    await router.push('/daily/songs')
    await flushRouter()
    expect(state.mounted.daily).toBe(1)

    app.unmount()
  })
})
