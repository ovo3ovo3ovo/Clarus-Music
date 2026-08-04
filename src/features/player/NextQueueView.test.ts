import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NextQueueView from './NextQueueView.vue'

const mocks = vi.hoisted(() => ({
  player: {
    currentTrack: {
      id: 1,
      name: 'Track',
      durationMs: 180_000,
      artists: [{ id: 2, name: 'Artist' }],
      album: { id: 3, name: 'Album', coverUrl: 'https://img.test/cover.jpg' },
      aliases: [],
      translatedNames: [],
      explicit: false,
      playable: true,
      unavailableReason: null,
    },
    playNextQueue: [
      {
        id: 4,
        name: 'Inserted',
        durationMs: 180_000,
        artists: [{ id: 2, name: 'Artist' }],
        album: { id: 3, name: 'Album', coverUrl: 'https://img.test/cover.jpg' },
        aliases: [],
        translatedNames: [],
        explicit: false,
        playable: true,
        unavailableReason: null,
      },
    ],
    upcomingTracks: [
      {
        id: 5,
        name: 'Upcoming',
        durationMs: 180_000,
        artists: [{ id: 2, name: 'Artist' }],
        album: { id: 3, name: 'Album', coverUrl: 'https://img.test/cover.jpg' },
        aliases: [],
        translatedNames: [],
        explicit: false,
        playable: true,
        unavailableReason: null,
      },
    ],
    queueBusy: false,
    queueLoadingTrackId: null,
    error: null,
    clearPlayNext: vi.fn(),
    removePlayNextAt: vi.fn(),
    playPlayNextAt: vi.fn(),
    playQueueTrack: vi.fn(),
  },
}))

vi.mock('./application/player-store', () => ({ usePlayerStore: () => mocks.player }))
vi.mock('@/features/search/presentation/VirtualTrackList.vue', () => ({
  default: {
    props: { tracks: { type: Array, required: true }, removable: Boolean },
    emits: ['play', 'remove'],
    template:
      '<div class="mock-list"><button class="mock-play" @click="$emit(\'play\', tracks[0], 0)">{{ tracks[0]?.name }}</button><button v-if="removable" class="mock-remove" @click="$emit(\'remove\', 0)">Remove</button></div>',
  },
}))

async function mountView() {
  const root = document.createElement('div')
  document.body.append(root)
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        queue: {
          nowPlaying: 'Now Playing',
          playNext: 'Play Next',
          clear: 'Clear queue',
          nextUp: 'Next Up',
          end: 'End of queue',
          empty: 'Nothing is playing',
        },
      },
    },
  })
  const app = createApp(NextQueueView).use(i18n)
  app.mount(root)
  await nextTick()
  return { app, root }
}

describe('NextQueueView', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('renders all legacy queue sections and wires play-next actions', async () => {
    const { app, root } = await mountView()
    expect(root.textContent).toContain('Now Playing')
    expect(root.textContent).toContain('Play Next')
    expect(root.textContent).toContain('Next Up')

    const playButtons = root.querySelectorAll<HTMLButtonElement>('.mock-play')
    playButtons[1]?.click()
    playButtons[2]?.click()
    root.querySelector<HTMLButtonElement>('.mock-remove')?.click()
    root.querySelector<HTMLButtonElement>('.section-heading > button')?.click()

    expect(mocks.player.playPlayNextAt).toHaveBeenCalledWith(0)
    expect(mocks.player.playQueueTrack).toHaveBeenCalledWith(5)
    expect(mocks.player.removePlayNextAt).toHaveBeenCalledWith(0)
    expect(mocks.player.clearPlayNext).toHaveBeenCalledOnce()
    app.unmount()
  })
})
