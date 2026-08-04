import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TrackGrid from './TrackGrid.vue'

const play = vi.fn()

vi.mock('vue-router', () => ({
  RouterLink: { props: ['to'], template: '<a><slot /></a>' },
}))
vi.mock('@/components/common/AppIcon.vue', () => ({
  default: { template: '<span class="mock-icon" />' },
}))
vi.mock('@/features/search/presentation/TrackContextMenu.vue', () => ({
  default: {
    props: ['track', 'position'],
    emits: ['close', 'play'],
    template:
      '<button v-if="track" class="mock-context" @click="$emit(\'play\', track)">{{ track.name }}</button>',
  },
}))

const track = {
  id: 7,
  name: 'Track',
  durationMs: 180_000,
  artists: [{ id: 2, name: 'Artist' }],
  album: { id: 3, name: 'Album', coverUrl: 'https://img.test/cover.jpg' },
  aliases: [],
  translatedNames: [],
  explicit: false,
  playable: true,
  unavailableReason: null,
}

describe('TrackGrid', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('opens the shared context menu and preserves the selected track index', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { search: { playTrack: 'Play track' } } },
    })
    const app = createApp(TrackGrid, {
      tracks: [track],
      currentTrackId: null,
      busyTrackId: null,
      onPlay: play,
    })
      .use(createPinia())
      .use(i18n)
    app.mount(root)

    root
      .querySelector('.track-row')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }))
    await nextTick()
    const contextButton = root.querySelector<HTMLButtonElement>('.mock-context')
    expect(contextButton?.textContent).toBe('Track')
    contextButton?.click()
    expect(play).toHaveBeenCalledWith(track, 0)
    app.unmount()
  })
})
