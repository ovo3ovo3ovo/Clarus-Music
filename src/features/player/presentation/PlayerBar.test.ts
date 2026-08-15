import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types/music'
import PlayerBar from './PlayerBar.vue'

const mocks = vi.hoisted(() => ({
  player: {
    currentTrack: {
      id: 10,
      name: 'Test Track',
      artists: [{ id: 20, name: 'Artist' }],
      album: { id: 30, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
    },
    pendingTrack: null as Track | null,
    duration: 180,
    progress: 0,
    volume: 1,
    repeatMode: 'off',
    shuffle: false,
    liked: false as boolean | null,
    likeBusy: false,
    queueBusy: false,
    error: null,
    playing: false,
    enabled: true,
    playbackClock: { read: vi.fn(() => 0) },
    togglePlayback: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    cycleRepeatMode: vi.fn(),
    toggleShuffle: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    toggleLike: vi.fn(async () => true),
  },
  lyrics: { open: vi.fn() },
  auth: { session: { user: null } },
  toast: { show: vi.fn() },
}))

const schedulerMocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  wake: vi.fn(),
}))

vi.mock('@/features/player/application/player-store', () => ({
  usePlayerStore: () => mocks.player,
}))
vi.mock('@/features/player/application/playback-frame-scheduler', () => ({
  playbackFrameScheduler: schedulerMocks,
}))
vi.mock('@/features/lyrics/application/lyrics-store', () => ({
  useLyricsStore: () => mocks.lyrics,
}))
vi.mock('@/features/auth/application/auth-store', () => ({
  useAuthStore: () => mocks.auth,
}))
vi.mock('@/app/toast-store', () => ({
  useToastStore: () => mocks.toast,
}))

async function mountBar() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<p>Home</p>' } },
      { path: '/next', component: { template: '<p>Next</p>' } },
      { path: '/album/:id', component: { template: '<p>Album</p>' } },
    ],
  })
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        player: {
          previous: 'Previous',
          play: 'Play',
          pause: 'Pause',
          next: 'Next',
          lyrics: 'Lyrics',
          nextUp: 'Next up',
          repeat: 'Repeat',
          repeatTrack: 'Repeat track',
          shuffle: 'Shuffle',
          like: 'Like song',
          unlike: 'Unlike song',
          checkingLike: 'Checking liked status',
          liked: 'Added to Liked Songs',
          unliked: 'Removed from Liked Songs',
          likeFailed: 'Could not update liked status',
          loading: 'Loading',
        },
      },
    },
  })
  await router.push('/')
  await router.isReady()
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(PlayerBar).use(router).use(i18n)
  app.mount(root)
  await nextTick()
  return { app, root, router }
}

describe('PlayerBar controls', () => {
  beforeEach(() => {
    mocks.player.repeatMode = 'off'
    mocks.player.shuffle = false
    mocks.player.queueBusy = false
    mocks.player.pendingTrack = null
    mocks.player.playing = false
    mocks.player.progress = 0
    mocks.player.duration = 180
    schedulerMocks.subscribe.mockReset()
    schedulerMocks.wake.mockReset()
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('keeps standard transport and queue mode controls available', async () => {
    const { app, root, router } = await mountBar()
    root.querySelector<HTMLButtonElement>('button[aria-label="Previous"]')?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Next"]')?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Next up"]')?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Lyrics"]')?.click()
    await nextTick()

    expect(mocks.player.previous).toHaveBeenCalledOnce()
    expect(mocks.player.next).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/next'))
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="Next up"]')?.disabled).toBe(
      false,
    )
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="Repeat"]')?.disabled).toBe(
      false,
    )
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="Shuffle"]')?.disabled).toBe(
      false,
    )
    app.unmount()
  })

  it('connects standard transport and queue mode controls', async () => {
    const { app, root, router } = await mountBar()
    root.querySelector<HTMLButtonElement>('button[aria-label="Previous"]')?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Next"]')?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Repeat"]')?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Shuffle"]')?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Next up"]')?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Lyrics"]')?.click()
    await nextTick()

    expect(mocks.player.previous).toHaveBeenCalledOnce()
    expect(mocks.player.next).toHaveBeenCalledOnce()
    expect(mocks.player.cycleRepeatMode).toHaveBeenCalledOnce()
    expect(mocks.player.toggleShuffle).toHaveBeenCalledOnce()
    expect(mocks.lyrics.open).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/next'))
    app.unmount()
  })

  it('opens the current track album from the player cover', async () => {
    const { app, root, router } = await mountBar()
    const cover = root.querySelector<HTMLAnchorElement>('.track-cover-link')

    expect(cover?.getAttribute('href')).toBe('/album/30')
    expect(root.querySelector('.metadata span')?.textContent?.trim()).toBe('Artist · Album')
    cover?.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/album/30'))
    app.unmount()
  })

  it('clearly marks enabled shuffle and repeat modes as selected', async () => {
    mocks.player.shuffle = true
    mocks.player.repeatMode = 'all'
    const { app, root } = await mountBar()

    const shuffle = root.querySelector<HTMLButtonElement>('button[aria-label="Shuffle"]')
    const repeat = root.querySelector<HTMLButtonElement>('button[aria-label="Repeat"]')
    expect(shuffle?.classList).toContain('active')
    expect(shuffle?.getAttribute('aria-pressed')).toBe('true')
    expect(repeat?.classList).toContain('active')
    expect(repeat?.getAttribute('aria-pressed')).toBe('true')
    app.unmount()
  })

  it('keeps a local progress preview while dragging, then seeks on release', async () => {
    mocks.player.progress = 0
    const { app, root } = await mountBar()
    const progress = root.querySelector<HTMLInputElement>('input.progress')
    expect(progress).not.toBeNull()
    if (!progress) return

    progress.value = '72'
    progress.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    progress.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(root.querySelector('.progress-row span')?.textContent).toBe('1:12')
    expect(mocks.player.seek).not.toHaveBeenCalled()

    progress.dispatchEvent(new Event('change', { bubbles: true }))
    expect(mocks.player.seek).toHaveBeenCalledWith(72)
    expect(mocks.player.togglePlayback).toHaveBeenCalledOnce()
    app.unmount()
  })

  it('updates the visible playback progress directly from the shared frame clock', async () => {
    mocks.player.playing = true
    mocks.player.progress = 4
    const stop = vi.fn()
    const frame = {
      tick: null as ((timestamp: number, currentTime: number) => void) | null,
    }
    schedulerMocks.subscribe.mockImplementation((subscriber) => {
      frame.tick = subscriber
      return stop
    })

    const { app, root } = await mountBar()
    const progress = root.querySelector<HTMLInputElement>('input.progress')

    expect(schedulerMocks.subscribe).toHaveBeenCalledWith(
      expect.any(Function),
      mocks.player.playbackClock.read,
    )
    frame.tick?.(100, 90)

    expect(progress?.value).toBe('90')
    expect(progress?.style.getPropertyValue('--range-progress')).toBe('50%')
    expect(root.querySelector('.progress-row span')?.textContent).toBe('1:30')
    expect(mocks.player.progress).toBe(4)

    app.unmount()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('holds a seek preview when a cancelled frame callback arrives', async () => {
    mocks.player.playing = true
    mocks.player.progress = 4
    const stop = vi.fn()
    const frame = {
      tick: null as ((timestamp: number, currentTime: number) => void) | null,
    }
    schedulerMocks.subscribe.mockImplementation((subscriber) => {
      frame.tick = subscriber
      return stop
    })

    const { app, root } = await mountBar()
    const progress = root.querySelector<HTMLInputElement>('input.progress')
    expect(progress).not.toBeNull()
    if (!progress) return

    progress.value = '72'
    progress.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    progress.dispatchEvent(new Event('input', { bubbles: true }))
    frame.tick?.(100, 90)

    expect(stop).toHaveBeenCalledOnce()
    expect(progress.value).toBe('72')
    expect(root.querySelector('.progress-row span')?.textContent).toBe('1:12')

    app.unmount()
  })

  it('shows the selected next track immediately while its stream is resolving', async () => {
    mocks.player.queueBusy = true
    mocks.player.pendingTrack = {
      id: 11,
      name: 'Preparing Next Track',
      durationMs: 251_000,
      artists: [{ id: 21, name: 'Next Artist' }],
      album: { id: 31, name: 'Next Album', coverUrl: 'https://img.test/next.jpg' },
      aliases: [],
      translatedNames: [],
      explicit: false,
      playable: true,
      unavailableReason: null,
    }

    const { app, root } = await mountBar()

    expect(root.textContent).toContain('Preparing Next Track')
    expect(root.textContent).toContain('Loading')
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="Next"]')?.disabled).toBe(false)
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="Play"]')?.disabled).toBe(true)
    app.unmount()
  })
})
