import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DailySongsView from './DailySongsView.vue'

const mocks = vi.hoisted(() => ({
  dailyLoad: vi.fn(),
  resolveStream: vi.fn(),
  setQueue: vi.fn(),
  playerLoad: vi.fn(),
  auth: {
    restoring: false,
    session: { authenticated: true },
  },
}))

vi.mock('./infrastructure/native-daily-songs', () => ({
  NativeDailySongsGateway: class {
    readonly load = mocks.dailyLoad
  },
}))

vi.mock('@/features/catalog/infrastructure/native-catalog', () => ({
  NativeCatalogGateway: class {
    readonly resolveStream = mocks.resolveStream
  },
}))

vi.mock('@/features/auth/application/auth-store', () => ({
  useAuthStore: () => mocks.auth,
}))

vi.mock('@/features/settings/application/settings-store', () => ({
  useSettingsStore: () => ({ settings: { musicQuality: '320000' } }),
}))

vi.mock('@/features/player/application/player-store', () => ({
  usePlayerStore: () => ({
    currentTrack: null,
    setQueue: mocks.setQueue,
    load: mocks.playerLoad,
  }),
}))

vi.mock('@/features/search/presentation/VirtualTrackList.vue', () => ({
  default: {
    props: ['tracks'],
    emits: ['play'],
    template: '<button class="mock-play" @click="$emit(\'play\', tracks[0])">Play</button>',
  },
}))

const track = {
  id: 10,
  name: 'Daily Track',
  durationMs: 180000,
  artists: [{ id: 20, name: 'Artist' }],
  album: { id: 30, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
  aliases: [],
  translatedNames: [],
  explicit: false,
  playable: true,
  unavailableReason: null,
}

async function flushView(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

async function mountView(path = '/daily/songs') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/daily/songs', component: DailySongsView },
      { path: '/login/account', component: { template: '<p>Login</p>' } },
    ],
  })
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        dailySongs: {
          title: 'Daily Songs',
          subtitle: 'Updated daily',
          retry: 'Retry',
          empty: 'Empty',
        },
      },
    },
  })
  await router.push(path)
  await router.isReady()
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(DailySongsView).use(router).use(i18n)
  app.mount(root)
  await flushView()
  return { app, root, router }
}

describe('DailySongsView', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
    mocks.auth.restoring = false
    mocks.auth.session.authenticated = true
  })

  it('loads recommendations and plays through the shared queue and audio engine', async () => {
    mocks.dailyLoad.mockResolvedValue({ tracks: [track] })
    mocks.resolveStream.mockResolvedValue({ kind: 'remote', url: 'https://audio.test/10.mp3' })
    mocks.playerLoad.mockResolvedValue(undefined)
    const { app, root } = await mountView()

    root.querySelector<HTMLButtonElement>('.mock-play')?.click()
    await flushView()

    expect(mocks.resolveStream).toHaveBeenCalledWith(10, '320000', expect.any(AbortSignal))
    expect(mocks.setQueue).toHaveBeenCalledWith([track], 0, 'daily:songs')
    expect(mocks.playerLoad).toHaveBeenCalledWith(
      track,
      { kind: 'remote', url: 'https://audio.test/10.mp3' },
      true,
      expect.any(AbortSignal),
    )
    app.unmount()
  })

  it('redirects anonymous access without invoking the private endpoint', async () => {
    mocks.auth.session.authenticated = false
    const { app, router } = await mountView()

    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/login/account'))
    expect(mocks.dailyLoad).not.toHaveBeenCalled()
    app.unmount()
  })

  it('aborts the native request when the route view is disposed', async () => {
    let signal: AbortSignal | undefined
    mocks.dailyLoad.mockImplementation(async (nextSignal?: AbortSignal) => {
      signal = nextSignal
      return await new Promise(() => undefined)
    })
    const { app } = await mountView()
    app.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
