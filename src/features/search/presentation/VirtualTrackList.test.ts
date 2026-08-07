/* eslint-disable vue/one-component-per-file -- mounts exercise cached and uncached list lifecycles. */
import { createApp, h, KeepAlive, nextTick, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VirtualTrackList from './VirtualTrackList.vue'

const { virtualizerOptions, virtualizerWillUpdate } = vi.hoisted(() => ({
  virtualizerOptions: vi.fn(),
  virtualizerWillUpdate: vi.fn(),
}))

vi.mock('vue-router', () => ({
  RouterLink: { props: ['to'], template: '<a><slot /></a>' },
}))
vi.mock('@/components/common/AppIcon.vue', () => ({
  default: { props: ['name'], template: '<span :data-icon="name" />' },
}))
vi.mock('./TrackContextMenu.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (options: unknown) => {
    virtualizerOptions(options)
    return {
      value: {
        getVirtualItems: () => [
          { key: 0, index: 0, start: 0 },
          { key: 1, index: 1, start: 46 },
        ],
        getTotalSize: () => 92,
        _willUpdate: virtualizerWillUpdate,
        measure: () => undefined,
      },
    }
  },
}))

const tracks = [
  {
    id: 1,
    name: 'Current track',
    durationMs: 180_000,
    artists: [{ id: 11, name: 'Artist one' }],
    album: { id: 21, name: 'Album one', coverUrl: 'https://img.test/one.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  },
  {
    id: 2,
    name: 'Selected next track',
    durationMs: 200_000,
    artists: [{ id: 12, name: 'Artist two' }],
    album: { id: 22, name: 'Album two', coverUrl: 'https://img.test/two.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  },
]

function mountList(listTracks: readonly (typeof tracks)[number][]) {
  const scroller = document.createElement('main')
  scroller.className = 'app-content'
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
  scroller.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 1_200, bottom: 600, width: 1_200, height: 600 }) as DOMRect
  const root = document.createElement('div')
  scroller.append(root)
  document.body.append(scroller)
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { search: { playTrack: 'Play track' }, queue: { remove: 'Remove' } } },
  })
  const app = createApp(VirtualTrackList, {
    tracks: listTracks,
    currentTrackId: null,
    busyTrackId: null,
  }).use(i18n)
  app.mount(root)
  return { app, root }
}

function latestVirtualizerOptions(): {
  value: { enabled: boolean; getScrollElement: () => Element | null }
} {
  return virtualizerOptions.mock.calls.at(-1)?.[0] as {
    value: { enabled: boolean; getScrollElement: () => Element | null }
  }
}

describe('VirtualTrackList', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('moves the active row to the selected next track before audio loading completes', async () => {
    const scroller = document.createElement('main')
    scroller.className = 'app-content'
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
    scroller.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 1_200, bottom: 600, width: 1_200, height: 600 }) as DOMRect
    const root = document.createElement('div')
    scroller.append(root)
    document.body.append(scroller)
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { search: { playTrack: 'Play track' }, queue: { remove: 'Remove' } } },
    })
    const app = createApp(VirtualTrackList, {
      tracks,
      currentTrackId: 1,
      pendingTrackId: 2,
      busyTrackId: null,
    }).use(i18n)
    app.mount(root)
    await nextTick()
    await nextTick()

    const rows = root.querySelectorAll<HTMLElement>('.track-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.classList).not.toContain('playing')
    expect(rows[1]?.classList).toContain('playing')
    expect(rows[1]?.querySelector('.spinner')).not.toBeNull()
    app.unmount()
  })

  it('keeps short lists in native flow without activating the virtualizer', async () => {
    const { app, root } = mountList(tracks)
    await nextTick()

    const list = root.querySelector<HTMLElement>('.virtual-track-list')
    expect(list?.classList).not.toContain('is-virtualized')
    expect(list?.style.height).toBe('')
    expect(root.querySelectorAll('.track-row')).toHaveLength(tracks.length)
    expect(latestVirtualizerOptions().value.enabled).toBe(false)
    app.unmount()
  })

  it('activates virtualization for large result sets', async () => {
    const largeTrackList = Array.from({ length: 96 }, (_, index) => ({
      ...tracks[index % tracks.length]!,
      id: index + 100,
      name: `Track ${index + 1}`,
      album: {
        ...tracks[index % tracks.length]!.album,
        id: index + 1_000,
      },
    }))
    const { app, root } = mountList(largeTrackList)
    await nextTick()

    const list = root.querySelector<HTMLElement>('.virtual-track-list')
    expect(list?.classList).toContain('is-virtualized')
    expect(list?.style.height).toBe('92px')
    expect(root.querySelectorAll('.track-row')).toHaveLength(2)
    expect(latestVirtualizerOptions().value.enabled).toBe(true)
    app.unmount()
  })

  it('releases the shared scroller while its cached route is inactive', async () => {
    const scroller = document.createElement('main')
    scroller.className = 'app-content'
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
    scroller.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 1_200, bottom: 600, width: 1_200, height: 600 }) as DOMRect
    const root = document.createElement('div')
    scroller.append(root)
    document.body.append(scroller)
    const active = ref(true)
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { search: { playTrack: 'Play track' }, queue: { remove: 'Remove' } } },
    })
    const app = createApp({
      setup() {
        return () =>
          h(KeepAlive, null, {
            default: () =>
              active.value
                ? h(VirtualTrackList, {
                    tracks: Array.from({ length: 96 }, (_, index) => ({
                      ...tracks[0]!,
                      id: index + 500,
                    })),
                    currentTrackId: null,
                    busyTrackId: null,
                  })
                : h('div'),
          })
      },
    }).use(i18n)
    app.mount(root)
    await nextTick()
    expect(latestVirtualizerOptions().value.getScrollElement()).toBe(scroller)

    virtualizerWillUpdate.mockClear()
    active.value = false
    await nextTick()
    expect(latestVirtualizerOptions().value.getScrollElement()).toBeNull()
    expect(virtualizerWillUpdate).toHaveBeenCalledOnce()
    app.unmount()
  })
})
