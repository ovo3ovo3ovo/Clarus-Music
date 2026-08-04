import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TrackContextMenu from './TrackContextMenu.vue'

const mocks = vi.hoisted(() => ({
  user: null as null | { userId: number },
  push: vi.fn(),
  play: vi.fn(),
  close: vi.fn(),
  playlistPage: vi.fn(),
  addTracks: vi.fn(),
  likeCheck: vi.fn(),
  setLiked: vi.fn(),
  syncLikeState: vi.fn(),
  openNeteaseSong: vi.fn(),
}))

vi.mock('@/features/auth/application/auth-store', () => ({
  useAuthStore: () => ({
    session: {
      get user() {
        return mocks.user
      },
    },
  }),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/features/library/infrastructure/native-library', () => ({
  NativeLibraryGateway: class {
    playlistPage = mocks.playlistPage
  },
}))
vi.mock('@/features/playlist/infrastructure/native-playlist', () => ({
  NativePlaylistGateway: class {
    addTracks = mocks.addTracks
  },
}))
vi.mock('@/features/player/infrastructure/native-like', () => ({
  NativeTrackLikeGateway: class {
    check = mocks.likeCheck
    setLiked = mocks.setLiked
  },
}))
vi.mock('@/features/player/application/player-store', () => ({
  usePlayerStore: () => ({ syncLikeState: mocks.syncLikeState }),
}))
vi.mock('@/platform/external-links', () => ({
  externalLinkGateway: { openNeteaseSong: mocks.openNeteaseSong },
}))
vi.mock('@/components/common/AppIcon.vue', () => ({
  default: { template: '<span class="mock-icon" />' },
}))

const track = {
  id: 7,
  name: 'Track',
  durationMs: 180_000,
  artists: [
    { id: 2, name: 'Artist' },
    { id: 5, name: 'Guest' },
  ],
  album: { id: 3, name: 'Album', coverUrl: 'https://img.test/cover.jpg' },
  aliases: [],
  translatedNames: [],
  explicit: false,
  playable: true,
  unavailableReason: null,
}

async function mountMenu() {
  const root = document.createElement('div')
  document.body.append(root)
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        player: {
          play: 'Play',
          addToPlaylist: 'Add to playlist',
          like: 'Like song',
          unlike: 'Unlike song',
          viewAlbum: 'Open album',
          viewArtist: 'Open artist',
          openInBrowser: 'Open in browser',
          copySongInfo: 'Copy song info',
          copySongLink: 'Copy song link',
          copyUnavailable: 'Copy unavailable',
          loading: 'Loading',
          noPlaylists: 'No playlists',
        },
      },
    },
  })
  const app = createApp(TrackContextMenu, {
    track,
    position: { x: 20, y: 30 },
    onPlay: mocks.play,
    onClose: mocks.close,
  }).use(i18n)
  app.mount(root)
  await nextTick()
  return { app, root }
}

describe('TrackContextMenu', () => {
  afterEach(() => {
    mocks.user = null
    vi.clearAllMocks()
    document.body.replaceChildren()
  })

  it('plays the selected track and redirects anonymous playlist actions to QR login', async () => {
    const { app } = await mountMenu()
    const buttons = document.body.querySelectorAll<HTMLButtonElement>(
      '.track-context-menu > button',
    )
    buttons[0]?.click()
    expect(mocks.play).toHaveBeenCalledWith(track)
    expect(mocks.close).toHaveBeenCalled()

    buttons[1]?.click()
    await nextTick()
    expect(mocks.push).toHaveBeenCalledWith('/login/account')
    app.unmount()
  })

  it('loads owned playlists and adds the selected track through the native mutation', async () => {
    mocks.user = { userId: 9 }
    mocks.playlistPage.mockResolvedValue({
      items: [
        { id: 1, creatorId: 9, name: 'Liked Songs' },
        { id: 2, creatorId: 9, name: 'Road Trip' },
        { id: 3, creatorId: 8, name: 'Other' },
      ],
    })
    mocks.addTracks.mockResolvedValue(undefined)
    const { app } = await mountMenu()

    document.body.querySelectorAll<HTMLButtonElement>('.track-context-menu > button')[1]?.click()
    await nextTick()
    await nextTick()
    const playlistButton = document.body.querySelector<HTMLButtonElement>(
      '.playlist-submenu button',
    )
    expect(playlistButton?.textContent).toContain('Road Trip')
    playlistButton?.click()
    await nextTick()
    expect(mocks.addTracks).toHaveBeenCalledWith(2, [7], expect.any(AbortSignal))
    app.unmount()
  })

  it('likes arbitrary tracks and exposes navigation and copy actions', async () => {
    mocks.user = { userId: 9 }
    mocks.likeCheck.mockResolvedValue(false)
    mocks.setLiked.mockResolvedValue(true)
    mocks.openNeteaseSong.mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { app } = await mountMenu()
    const buttons = document.body.querySelectorAll<HTMLButtonElement>(
      '.track-context-menu > button',
    )

    buttons[2]?.click()
    await nextTick()
    await nextTick()
    expect(mocks.likeCheck).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    expect(mocks.setLiked).toHaveBeenCalledWith(7, true, expect.any(AbortSignal))
    expect(mocks.syncLikeState).toHaveBeenCalledWith(7, true)

    buttons[3]?.click()
    await nextTick()
    expect(mocks.push).toHaveBeenCalledWith('/album/3')
    buttons[4]?.click()
    await nextTick()
    const artistButtons =
      document.body.querySelectorAll<HTMLButtonElement>('.artist-submenu button')
    expect([...artistButtons].map((button) => button.textContent?.trim())).toEqual([
      'Artist',
      'Guest',
    ])
    artistButtons[1]?.click()
    await nextTick()
    expect(mocks.push).toHaveBeenCalledWith('/artist/5')

    buttons[5]?.click()
    await nextTick()
    expect(mocks.openNeteaseSong).toHaveBeenCalledWith(7)
    buttons[6]?.click()
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('Track - Artist, Guest')
    buttons[7]?.click()
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('https://music.163.com/song?id=7')
    app.unmount()
  })
})
