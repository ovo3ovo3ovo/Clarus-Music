import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MusicVideoView from './MusicVideoView.vue'

interface MockPlayer {
  source: unknown
  readonly media: HTMLVideoElement
  readonly options: unknown
  autoplay: boolean
  volume: number
  readonly events: Map<string, () => void>
  readonly stop: ReturnType<typeof vi.fn>
  readonly destroy: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  setSubscription: vi.fn(),
  players: [] as MockPlayer[],
  audio: {
    playing: false,
    volume: 0.6,
    togglePlayback: vi.fn(async () => undefined),
  },
}))

vi.mock('plyr', () => ({
  default: class implements MockPlayer {
    private sourceValue: unknown = null
    media: HTMLVideoElement
    readonly options: unknown
    autoplay = false
    volume = 1
    readonly events = new Map<string, () => void>()
    readonly stop = vi.fn()
    readonly destroy = vi.fn()

    constructor(target: HTMLElement, options: unknown) {
      this.media = target as HTMLVideoElement
      this.options = options
      mocks.players.push(this)
    }

    get source(): unknown {
      return this.sourceValue
    }

    set source(value: unknown) {
      this.sourceValue = value
      // Plyr replaces its native node during a source change. This fake keeps
      // that lifecycle visible to the view regression test.
      const replacement = document.createElement('video')
      this.media.replaceWith(replacement)
      this.media = replacement
    }

    on(event: string, callback: () => void): void {
      this.events.set(event, callback)
    }
  },
}))

vi.mock('./infrastructure/native-music-video', () => ({
  NativeMusicVideoGateway: class {
    readonly detail = mocks.detail
    readonly setSubscription = mocks.setSubscription
  },
}))

vi.mock('@/features/player/application/player-store', () => ({
  usePlayerStore: () => mocks.audio,
}))

vi.mock('@/features/auth/application/auth-store', () => ({
  useAuthStore: () => ({ session: { authenticated: false } }),
}))

function detail(id: number) {
  return {
    id,
    name: `MV ${id}`,
    coverUrl: `https://img.test/${id}.jpg`,
    artistId: 20,
    artistName: 'Artist',
    playCount: 30,
    publishTime: '2026-01-01',
    durationMs: 40,
    subscribed: false,
    sources: [
      {
        resolution: 1080,
        url: `https://video.test/${id}-1080.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: 100,
      },
      {
        resolution: 720,
        url: `https://video.test/${id}-720.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: 80,
      },
    ],
    similarVideos: [],
  }
}

async function flushView(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('MusicVideoView', () => {
  afterEach(() => {
    document.body.replaceChildren()
    mocks.players.length = 0
    mocks.audio.playing = false
  })

  it('owns one Plyr instance across routes and pauses audio when video plays', async () => {
    const nativeLoad = vi.spyOn(HTMLMediaElement.prototype, 'load')
    const loadedElements: HTMLMediaElement[] = []
    nativeLoad.mockImplementation(function (this: HTMLMediaElement) {
      loadedElements.push(this)
    })
    mocks.detail.mockImplementation(async (videoId: number) => detail(videoId))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/mv/:id', component: MusicVideoView }],
    })
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: {
        en: {
          musicVideo: {
            loading: 'Loading',
            retry: 'Retry',
            views: 'Views',
            moreVideos: 'More Videos',
            save: 'Save',
            saved: 'Saved',
            savedFeedback: 'Saved',
            removedFeedback: 'Removed',
            more: 'More',
            copyLink: 'Copy',
            openBrowser: 'Open',
            copied: 'Copied',
            copyFailed: 'Copy failed',
            playbackFailed: 'Playback failed',
          },
        },
      },
    })
    await router.push('/mv/10')
    await router.isReady()
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp(MusicVideoView).use(router).use(i18n)
    app.mount(root)
    const originalElement = root.querySelector<HTMLVideoElement>('video')
    await flushView()

    expect(mocks.players).toHaveLength(1)
    const player = mocks.players[0]!
    expect(player.volume).toBe(0.6)
    expect(player.source).toMatchObject({
      title: 'MV 10',
      sources: [{ size: 1080 }, { size: 720 }],
    })
    expect(player.options).toMatchObject({ blankVideo: '', quality: { default: 720 } })
    expect(root.querySelector<HTMLVideoElement>('video')?.preload).toBe('metadata')

    mocks.audio.playing = true
    player.events.get('playing')?.()
    await flushView()
    expect(mocks.audio.togglePlayback).toHaveBeenCalledOnce()

    await router.push('/mv/11?autoplay=true')
    await flushView()
    expect(mocks.players).toHaveLength(1)
    expect(player.stop).toHaveBeenCalledOnce()
    expect(nativeLoad).toHaveBeenCalledTimes(3)
    expect(loadedElements).not.toContain(originalElement)
    expect(root.querySelector<HTMLVideoElement>('video')?.preload).toBe('auto')
    expect(player.autoplay).toBe(true)
    expect(player.source).toMatchObject({ title: 'MV 11' })

    app.unmount()
    expect(player.destroy).toHaveBeenCalledOnce()
    expect(nativeLoad).toHaveBeenCalledTimes(4)
  })
})
