import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VirtualTrackList from './VirtualTrackList.vue'

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
  useVirtualizer: () => ({
    value: {
      getVirtualItems: () => [
        { key: 0, index: 0, start: 0 },
        { key: 1, index: 1, start: 46 },
      ],
      getTotalSize: () => 92,
      _willUpdate: () => undefined,
      measure: () => undefined,
    },
  }),
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
})
