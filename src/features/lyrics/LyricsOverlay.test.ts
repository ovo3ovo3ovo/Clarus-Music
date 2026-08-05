import { createApp, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types/music'
import LyricsOverlay from './LyricsOverlay.vue'

vi.mock('./infrastructure/cover-gradient', () => ({
  extractCoverGradient: vi.fn().mockResolvedValue(null),
}))

const mocks = vi.hoisted(() => ({
  player: {
    currentTrack: {
      id: 10,
      name: 'Test Track',
      durationMs: 180_000,
      artists: [{ id: 20, name: 'Artist' }],
      album: { id: 30, name: 'Album', coverUrl: 'https://img.test/album.jpg' },
    },
    pendingTrack: null as Track | null,
    progress: 1.1,
    duration: 180,
    volume: 0.8,
    repeatMode: 'off',
    shuffle: false,
    queueBusy: false,
    playing: false,
    enabled: true,
    liked: false,
    likeBusy: false,
    seek: vi.fn(),
    setVolume: vi.fn(),
    toggleLike: vi.fn().mockResolvedValue(true),
    cycleRepeatMode: vi.fn(),
    toggleShuffle: vi.fn(),
    togglePlayback: vi.fn().mockResolvedValue(undefined),
    previous: vi.fn(),
    next: vi.fn(),
  },
  lyrics: {
    visible: true,
    loading: false,
    error: null as string | null,
    mode: 'translation' as 'translation' | 'romanization',
    lyrics: {
      instrumental: false,
      lines: [
        {
          timeMs: 1_000,
          original: 'Original',
          translation: 'Translation',
          romanization: 'Original romanized',
        },
        { timeMs: 2_000, original: 'Second', translation: null, romanization: null },
      ],
    },
    scrollTop: 0,
    close: vi.fn(),
    setScrollTop: vi.fn((value: number) => {
      mocks.lyrics.scrollTop = value
    }),
    switchMode: vi.fn(),
  },
  settings: {
    lyricFontSize: 36,
    showLyricsTranslation: true,
    lyricsBackground: 'off' as 'off' | 'cover' | 'blur' | 'dynamic',
  },
}))

vi.mock('@/features/player/application/player-store', () => ({
  usePlayerStore: () => reactive(mocks.player),
}))
vi.mock('@/features/lyrics/application/lyrics-store', () => ({
  useLyricsStore: () => reactive(mocks.lyrics),
}))
vi.mock('@/features/settings/application/settings-store', () => ({
  useSettingsStore: () => ({ settings: reactive(mocks.settings) }),
}))

async function mountOverlay() {
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
          repeat: 'Repeat',
          repeatTrack: 'Repeat track',
          shuffle: 'Shuffle',
          lyrics: 'Lyrics',
          like: 'Like',
          unlike: 'Unlike',
        },
        lyrics: {
          close: 'Close lyrics',
          volume: 'Volume',
          progress: 'Playback progress',
          translation: 'Translation',
          romanization: 'Romanization',
          translationShort: 'TR',
          romanizationShort: 'RO',
          copy: 'Copy lyrics',
          copyWithTranslation: 'Copy with translation',
          copyWithRomanization: 'Copy with romanization',
          copied: 'Copied',
          copyFailed: 'Copy failed',
          loading: 'Loading lyrics',
          instrumental: 'Instrumental',
          empty: 'No lyrics',
        },
      },
    },
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(LyricsOverlay).use(i18n)
  app.mount(root)
  await nextTick()
  return { app, root }
}

describe('LyricsOverlay', () => {
  beforeEach(() => {
    mocks.player.playing = false
    mocks.player.pendingTrack = null
    mocks.player.progress = 1.1
    mocks.player.duration = 180
    mocks.lyrics.visible = true
    mocks.lyrics.scrollTop = 0
    mocks.lyrics.mode = 'translation'
    mocks.settings.lyricsBackground = 'off'
    mocks.settings.showLyricsTranslation = true
    mocks.player.seek.mockImplementation(function (this: { progress: number }, progress: number) {
      this.progress = progress
    })
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders translated lyrics and connects seeking, playback, and close controls', async () => {
    const { app, root } = await mountOverlay()
    const lines = root.querySelectorAll<HTMLButtonElement>('.lyric-line:not(.lyric-leading)')
    expect(lines).toHaveLength(2)
    expect(lines[0]?.textContent).toContain('Translation')
    expect(root.querySelector('.fullscreen-button')).toBeNull()

    lines[0]?.click()
    await nextTick()
    mocks.player.playing = true
    lines[1]?.click()
    root.querySelector<HTMLButtonElement>('button[aria-label="Close lyrics"]')?.click()
    await nextTick()

    expect(mocks.player.seek).toHaveBeenNthCalledWith(1, 1)
    expect(mocks.player.seek).toHaveBeenNthCalledWith(2, 2)
    expect(mocks.player.togglePlayback).toHaveBeenCalledOnce()
    expect(mocks.lyrics.close).toHaveBeenCalledOnce()
    app.unmount()
  })

  it('keeps shuffle on the left and repeat on the right like the main player bar', async () => {
    const { app, root } = await mountOverlay()
    const controls = root.querySelector('.media-controls')
    const buttons = [...(controls?.querySelectorAll('.icon-button') ?? [])]

    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Shuffle',
      'Previous',
      'Play',
      'Next',
      'Repeat',
    ])
    app.unmount()
  })

  it('keeps the like control beside the title and the extended volume control separate', async () => {
    const { app, root } = await mountOverlay()
    const titleRow = root.querySelector('.track-title-row')

    expect(titleRow?.textContent).toContain('Test Track')
    expect(titleRow?.querySelector('button[aria-label="Like"]')).not.toBeNull()
    expect(root.querySelector('.volume-control input[aria-label="Volume"]')).not.toBeNull()
    expect(root.querySelector('.lyrics-overlay > .volume-control')).not.toBeNull()

    app.unmount()
  })

  it('restores the lyric scroll anchor after the presentation is unmounted and mounted again', async () => {
    mocks.lyrics.scrollTop = 321
    const first = await mountOverlay()
    const firstContainer = first.root.querySelector<HTMLElement>('.lyrics-container')!
    await nextTick()
    expect(firstContainer.scrollTop).toBe(321)

    firstContainer.scrollTop = 654
    first.app.unmount()
    expect(mocks.lyrics.setScrollTop).toHaveBeenLastCalledWith(654)

    const second = await mountOverlay()
    const secondContainer = second.root.querySelector<HTMLElement>('.lyrics-container')!
    await nextTick()
    expect(secondContainer.scrollTop).toBe(654)
    second.app.unmount()
  })

  it('does not keep a lyric animation frame loop alive while playback is paused', async () => {
    const queued: FrameRequestCallback[] = []
    let nextFrameId = 0
    const originalRequestAnimationFrame = window.requestAnimationFrame
    const originalCancelAnimationFrame = window.cancelAnimationFrame
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      queued.push(callback)
      nextFrameId += 1
      return nextFrameId
    }) as typeof window.requestAnimationFrame
    window.cancelAnimationFrame = (() => undefined) as typeof window.cancelAnimationFrame

    try {
      const { app } = await mountOverlay()
      await nextTick()
      for (let index = 0; index < 10 && queued.length > 0; index += 1) {
        queued.shift()?.(index * 16)
      }
      expect(queued).toHaveLength(0)
      app.unmount()
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame
      window.cancelAnimationFrame = originalCancelAnimationFrame
    }
  })

  it('keeps lyrics on real playback progress while scrubbing and seeks only when committed', async () => {
    mocks.player.duration = 900
    const { app, root } = await mountOverlay()
    const progress = root.querySelector<HTMLInputElement>('input[aria-label="Playback progress"]')!
    const firstLine = root.querySelectorAll<HTMLElement>('.lyric-line:not(.lyric-leading)')[0]!
    const secondLine = root.querySelectorAll<HTMLElement>('.lyric-line:not(.lyric-leading)')[1]!
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)

    await new Promise((resolve) => window.setTimeout(resolve, 60))
    await nextTick()
    expect(progress.max).toBe('179')
    expect(firstLine.classList).toContain('highlight')
    expect(secondLine.classList).toContain('is-near')
    expect(firstLine.querySelector('small')?.textContent).toContain('Translation')
    scrollIntoView.mockClear()

    progress.value = '2'
    progress.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(mocks.player.seek).not.toHaveBeenCalled()
    expect(firstLine.classList).toContain('highlight')
    expect(secondLine.classList).not.toContain('highlight')
    expect(scrollIntoView).not.toHaveBeenCalled()

    progress.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 60))
    await nextTick()
    await nextTick()

    expect(mocks.player.seek).toHaveBeenCalledOnce()
    expect(mocks.player.seek).toHaveBeenCalledWith(2)
    expect(secondLine.classList).toContain('highlight')
    expect(scrollIntoView).not.toHaveBeenCalled()
    app.unmount()
  })

  it('follows the active line with a measured scroll target instead of staying at the initial offset', async () => {
    const { app, root } = await mountOverlay()
    const container = root.querySelector<HTMLElement>('.lyrics-container')!
    const firstLine = root.querySelectorAll<HTMLElement>('.lyric-line:not(.lyric-leading)')[0]!
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 3_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => (scrollTop = value),
      },
    })
    let scrollTop = 0
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    vi.spyOn(firstLine, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 1_000, 700, 80))

    await new Promise((resolve) => window.setTimeout(resolve, 100))
    expect(scrollTop).toBeGreaterThan(0)
    app.unmount()
  })

  it('advances the scroll spring between animation frames when motion is enabled', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    const { app, root } = await mountOverlay()
    const container = root.querySelector<HTMLElement>('.lyrics-container')!
    const firstLine = root.querySelectorAll<HTMLElement>('.lyric-line:not(.lyric-leading)')[0]!
    let scrollTop = 0
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 3_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => (scrollTop = value),
      },
    })
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    vi.spyOn(firstLine, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 1_000, 700, 80))

    await new Promise((resolve) => window.setTimeout(resolve, 120))
    expect(scrollTop).toBeGreaterThan(0)
    app.unmount()
  })

  it('commits a direct progress-bar click even when the browser emits no input event first', async () => {
    const { app, root } = await mountOverlay()
    const progress = root.querySelector<HTMLInputElement>('input[aria-label="Playback progress"]')!
    progress.value = '42'
    progress.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(mocks.player.seek).toHaveBeenCalledWith(42)
    expect(mocks.player.togglePlayback).toHaveBeenCalledOnce()
    app.unmount()
  })

  it('uses the hovered line as the clear focus during manual scrolling and restores playback focus', async () => {
    const { app, root } = await mountOverlay()
    const container = root.querySelector<HTMLElement>('.lyrics-container')!
    const lines = root.querySelectorAll<HTMLElement>('.lyric-line:not(.lyric-leading)')
    const secondLine = lines[1]!

    await new Promise((resolve) => window.setTimeout(resolve, 60))
    await nextTick()
    vi.useFakeTimers()
    container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 180 }))
    secondLine.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await nextTick()

    expect(container.classList).toContain('is-user-scrolling')
    expect(secondLine.classList).toContain('is-scroll-focus')
    expect(secondLine.style.getPropertyValue('--lyric-blur')).toBe('0px')

    vi.advanceTimersByTime(3_000)
    await nextTick()
    expect(container.classList).not.toContain('is-user-scrolling')
    expect(secondLine.classList).not.toContain('is-scroll-focus')
    expect(lines[0]?.classList).toContain('highlight')

    vi.useRealTimers()
    app.unmount()
  })

  it('renders the bounded dynamic background and keeps the legacy single mode toggle', async () => {
    mocks.settings.lyricsBackground = 'dynamic'
    const { app, root } = await mountOverlay()

    expect(root.querySelector('.lyrics-overlay')?.classList).toContain('dynamic-background')
    expect(root.querySelectorAll('.background-texture')).toHaveLength(1)
    const modeButton = root.querySelector<HTMLButtonElement>('.lyric-mode-button')
    expect(root.querySelector('.media-controls .lyric-mode-button')).toBeNull()
    const titleRow = root.querySelector('.track-title-row')
    const likeButton = titleRow?.querySelector('.track-like-button')
    expect(titleRow?.querySelector('.lyric-mode-button')).toBe(modeButton)
    expect(likeButton?.nextElementSibling).toBe(modeButton)
    expect(modeButton?.textContent?.trim()).toBe('TR')
    modeButton?.click()

    expect(mocks.lyrics.switchMode).toHaveBeenCalledWith('romanization')
    app.unmount()
  })

  it('copies the selected lyric or the original and secondary lyric from the context menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { app, root } = await mountOverlay()
    const firstLine = root.querySelector<HTMLButtonElement>('.lyric-line:not(.lyric-leading)')
    const translation = firstLine?.querySelector('small')

    translation?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 120 }),
    )
    await nextTick()
    let items = root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    expect(items).toHaveLength(2)
    items[0]?.click()
    await nextTick()
    expect(writeText).toHaveBeenLastCalledWith('Translation')

    translation?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 120 }),
    )
    await nextTick()
    items = root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    items[1]?.click()
    await nextTick()
    expect(writeText).toHaveBeenLastCalledWith('Original Translation')
    app.unmount()
  })

  it('moves lyric artwork, metadata, and progress to the selected next track immediately', async () => {
    mocks.player.progress = 93
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
    const { app, root } = await mountOverlay()

    expect(root.textContent).toContain('Preparing Next Track')
    expect(root.textContent).toContain('Next Artist - Next Album')
    expect(
      root.querySelector<HTMLInputElement>('input[aria-label="Playback progress"]')?.value,
    ).toBe('0')
    app.unmount()
  })
})
