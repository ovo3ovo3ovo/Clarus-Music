import { createApp, defineComponent, nextTick, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArtistView from './ArtistView.vue'

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  albumDetail: vi.fn(),
  resolveStream: vi.fn(),
  setSubscription: vi.fn(),
}))

vi.mock('./infrastructure/native-artist', () => ({
  NativeArtistGateway: class {
    readonly detail = mocks.detail
    readonly setSubscription = mocks.setSubscription
  },
}))

vi.mock('@/features/album/infrastructure/native-album', () => ({
  NativeAlbumGateway: class {
    readonly detail = mocks.albumDetail
  },
}))

vi.mock('@/features/catalog/infrastructure/native-catalog', () => ({
  NativeCatalogGateway: class {
    readonly resolveStream = mocks.resolveStream
  },
}))

vi.mock('@/features/auth/application/auth-store', () => ({
  useAuthStore: () => ({ session: { authenticated: false } }),
}))

vi.mock('@/features/settings/application/settings-store', () => ({
  useSettingsStore: () => ({ settings: { musicQuality: '320000' } }),
}))

vi.mock('@/features/player/application/player-store', () => ({
  usePlayerStore: () => ({
    currentTrack: null,
    pendingTrack: null,
    setQueue: vi.fn(),
    load: vi.fn(),
  }),
}))

vi.mock('@/components/common/AppIcon.vue', () => ({
  default: { props: ['name'], template: '<span class="mock-icon" :data-name="name" />' },
}))

vi.mock('@/components/common/CoverImage.vue', () => ({
  default: {
    props: ['source', 'alt'],
    template: '<img class="mock-cover" :src="source" :alt="alt" />',
  },
}))

vi.mock('@/components/common/ContentLoadingVeil.vue', () => ({
  default: { template: '<div class="mock-loading" />' },
}))

vi.mock('@/components/common/DescriptionDialog.vue', () => ({
  default: { template: '<div class="mock-description" />' },
}))

vi.mock('@/components/common/IconButton.vue', () => ({
  default: {
    props: ['title', 'icon'],
    emits: ['click'],
    template: '<button class="mock-icon-button" :title="title" @click="$emit(\'click\')" />',
  },
}))

vi.mock('@/features/catalog/presentation/ArtistList.vue', () => ({
  default: { props: ['artists'], template: '<div class="mock-artist-list" />' },
}))

vi.mock('@/features/search/presentation/VirtualTrackList.vue', () => ({
  default: {
    props: ['tracks'],
    emits: ['play'],
    template:
      '<div class="mock-track-list"><button class="mock-track-play" @click="$emit(\'play\', tracks[0])">Play</button></div>',
  },
}))

vi.mock('./presentation/ArtistAlbumGrid.vue', () => ({
  default: { props: ['albums'], emits: ['play'], template: '<div class="mock-album-grid" />' },
}))

vi.mock('./presentation/ArtistVideoGrid.vue', () => ({
  default: { props: ['videos'], template: '<div class="mock-video-grid" />' },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function artistDetail(id: number) {
  const track = {
    id: id * 10,
    name: `Track ${id}`,
    durationMs: 180_000,
    artists: [{ id, name: `Artist ${id}` }],
    album: { id: id * 100, name: `Album ${id}`, coverUrl: `https://img.test/${id}.jpg` },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  }
  return {
    artist: {
      id,
      name: `Artist ${id}`,
      coverUrl: `https://img.test/artist-${id}.jpg`,
      briefDescription: '',
      musicCount: 1,
      albumCount: 0,
      videoCount: 0,
      followed: false,
    },
    popularTracks: [track],
    latestRelease: null,
    albums: [],
    eps: [],
    videos: [],
    videosHasMore: false,
    similarArtists: [],
  }
}

async function flushView(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function messages() {
  return {
    artist: {
      loading: 'Loading artist',
      retry: 'Retry',
      artist: 'Artist',
      songs: 'songs',
      albumsCount: 'albums',
      videos: 'videos',
      play: 'Play',
      follow: 'Follow',
      following: 'Following',
      more: 'More',
      copyLink: 'Copy link',
      openBrowser: 'Open browser',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      latestRelease: 'Latest release',
      popularSongs: 'Popular songs',
      showMore: 'Show more',
      showLess: 'Show less',
      albums: 'Albums',
      musicVideos: 'Music videos',
      seeMore: 'See more',
      epsSingles: 'EPs and singles',
      similarArtists: 'Similar artists',
      descriptionTitle: 'Description',
      close: 'Close',
      noPlayableSongs: 'No playable songs',
      playAlbum: 'Play album',
    },
    album: { songs: 'songs' },
    search: { playTrack: 'Play' },
    playlist: { songs: 'songs' },
  }
}

async function mountKeptView(path = '/artist/1') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/artist/:id', name: 'artist', component: ArtistView },
      { path: '/artist/:id/mv', name: 'artistMV', component: { template: '<p>Artist videos</p>' } },
      { path: '/other', name: 'other', component: { template: '<p>Other</p>' } },
    ],
  })
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: messages() } })
  await router.push(path)
  await router.isReady()
  const visible = ref(true)
  const host = defineComponent({
    components: { ArtistView },
    setup() {
      return { visible }
    },
    template: '<KeepAlive><ArtistView v-if="visible" /></KeepAlive>',
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(host).use(router).use(i18n)
  app.mount(root)
  await flushView()
  return { app, root, router, visible }
}

describe('ArtistView keep-alive lifecycle', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('aborts a hidden detail request and resumes it after activation', async () => {
    const pending = deferred<ReturnType<typeof artistDetail>>()
    let firstSignal: AbortSignal | undefined
    mocks.detail.mockImplementationOnce((_id: number, signal?: AbortSignal) => {
      firstSignal = signal
      return pending.promise
    })

    const mounted = await mountKeptView()
    expect(mocks.detail).toHaveBeenCalledTimes(1)

    mounted.visible.value = false
    await nextTick()
    expect(firstSignal?.aborted).toBe(true)

    // A result that races with deactivation must not populate the cached tree.
    pending.resolve(artistDetail(1))
    await flushView()
    expect(mounted.root.querySelector('[data-artist-id]')).toBeNull()

    mocks.detail.mockResolvedValueOnce(artistDetail(1))
    mounted.visible.value = true
    await flushView()
    expect(mocks.detail).toHaveBeenCalledTimes(2)
    expect(mounted.root.querySelector('[data-artist-id="1"]')).not.toBeNull()

    const playback = deferred<{ kind: 'remote'; url: string }>()
    let playbackSignal: AbortSignal | undefined
    mocks.resolveStream.mockImplementationOnce(
      (_trackId: number, _quality: string, signal?: AbortSignal) => {
        playbackSignal = signal
        return playback.promise
      },
    )
    mounted.root.querySelector<HTMLButtonElement>('.mock-track-play')?.click()
    await flushView()
    mounted.visible.value = false
    await nextTick()
    expect(playbackSignal?.aborted).toBe(true)
    playback.resolve({ kind: 'remote', url: 'https://audio.test/1.mp3' })
    await flushView()

    mounted.app.unmount()
  })

  it('reloads the current artist when the route changes while hidden', async () => {
    mocks.detail.mockResolvedValue(artistDetail(1))
    const mounted = await mountKeptView('/artist/1')
    expect(mounted.root.querySelector('[data-artist-id="1"]')).not.toBeNull()

    mounted.visible.value = false
    await nextTick()
    await mounted.router.push('/artist/2')
    await flushView()
    expect(mocks.detail).toHaveBeenCalledTimes(1)

    mocks.detail.mockResolvedValueOnce(artistDetail(2))
    mounted.visible.value = true
    await flushView()
    expect(mocks.detail).toHaveBeenCalledWith(2, expect.any(AbortSignal))
    expect(mounted.root.querySelector('[data-artist-id="2"]')).not.toBeNull()

    mounted.app.unmount()
  })

  it('does not let a stale artist request repopulate the next route', async () => {
    const first = deferred<ReturnType<typeof artistDetail>>()
    const second = deferred<ReturnType<typeof artistDetail>>()
    let firstSignal: AbortSignal | undefined
    mocks.detail.mockImplementation((id: number, signal?: AbortSignal) => {
      if (id === 1) {
        firstSignal = signal
        return first.promise
      }
      return second.promise
    })

    const mounted = await mountKeptView('/artist/1')
    await mounted.router.push('/artist/2')
    await flushView()
    expect(firstSignal?.aborted).toBe(true)

    second.reject(new Error('Artist 2 unavailable'))
    await flushView()
    expect(mounted.root.querySelector('.request-error button')).not.toBeNull()

    first.resolve(artistDetail(1))
    await flushView()
    expect(mounted.root.querySelector('[data-artist-id]')).toBeNull()
    expect(mounted.root.querySelector('.request-error button')).not.toBeNull()

    mounted.app.unmount()
  })

  it('retries an initial failed request for the same artist', async () => {
    mocks.detail.mockRejectedValueOnce(new Error('Artist 1 unavailable'))
    const mounted = await mountKeptView('/artist/1')
    expect(mounted.root.querySelector('.request-error button')).not.toBeNull()

    mocks.detail.mockResolvedValueOnce(artistDetail(1))
    mounted.root.querySelector<HTMLButtonElement>('.request-error button')?.click()
    await flushView()

    expect(mounted.root.querySelector('[data-artist-id="1"]')).not.toBeNull()
    mounted.app.unmount()
  })

  it('handles same-artist, artist-MV, and leave-and-return routes', async () => {
    mocks.detail.mockImplementation((id: number) => Promise.resolve(artistDetail(id)))
    const mounted = await mountKeptView('/artist/1')

    await mounted.router.push('/artist/1?tab=popular')
    await flushView()
    await mounted.router.push('/artist/2/mv')
    await flushView()
    await mounted.router.push('/artist/2')
    await flushView()
    expect(mounted.root.querySelector('[data-artist-id="2"]')).not.toBeNull()
    await mounted.router.push('/other')
    await flushView()
    await mounted.router.push('/artist/1')
    await flushView()
    expect(mounted.root.querySelector('[data-artist-id="1"]')).not.toBeNull()

    mounted.app.unmount()
  })
})
