import { describe, expect, it, vi } from 'vitest'

type FakeImageRecord = {
  readonly listeners: Record<string, () => void>
  readonly sources: string[]
  src: string
  decoding: string
}

function createFakeImageClass(images: FakeImageRecord[]) {
  return class FakeImage implements FakeImageRecord {
    readonly listeners: Record<string, () => void> = {}
    readonly sources: string[] = []
    decoding = ''
    private value = ''

    get src(): string {
      return this.value
    }

    set src(value: string) {
      this.value = value
      this.sources.push(value)
    }

    addEventListener(event: string, listener: () => void): void {
      this.listeners[event] = listener
    }

    constructor() {
      images.push(this)
    }
  }
}

async function freshCoverImageModule() {
  vi.resetModules()
  return import('./cover-image')
}

describe('coverImageUrl', () => {
  it('keeps visible artwork on the browser HTTPS pipeline on macOS', async () => {
    const originalInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__')
    const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
    const invoke = vi.fn()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    })
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    try {
      const { coverImageUrl } = await freshCoverImageModule()
      const result = coverImageUrl('https://p1.music.126.net/hash/cover.jpg', 40, 40, {
        role: 'row',
        pixelRatio: 1,
      })

      expect(new URL(result).protocol).toBe('https:')
      expect(new URL(result).hostname).toBe('p1.music.126.net')
      expect(new URL(result).searchParams.get('param')).toBe('96y96')
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      if (originalInternals) {
        Object.defineProperty(window, '__TAURI_INTERNALS__', originalInternals)
      } else {
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      }
      if (originalPlatform) {
        Object.defineProperty(navigator, 'platform', originalPlatform)
      }
    }
  })

  it('rejects custom, blob, data, and relative sources for visible artwork', async () => {
    const { coverImageUrl, coverImageCandidates } = await freshCoverImageModule()
    const invalidSources = [
      'custom-image://localhost/v1?source=https%3A%2F%2Fimg.test%2Fcover.jpg&w=96&h=96',
      'blob:https://img.test/cover',
      'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
      '/covers/cover.jpg',
    ]

    for (const source of invalidSources) {
      expect(coverImageUrl(source, 40, 40, { role: 'row' })).toBe('')
      expect(coverImageCandidates(source, 40, 40, { role: 'row' })).toEqual([])
    }
  })

  it('permits only the self-runner loopback image fixture over HTTP', async () => {
    const { coverImageUrl } = await freshCoverImageModule()
    expect(
      coverImageUrl('http://127.0.0.1:43123/clarus-perf/cover.png', 40, 40, {
        role: 'row',
        pixelRatio: 1,
      }),
    ).toBe('http://127.0.0.1:43123/clarus-perf/cover.png?param=96y96')
    expect(coverImageUrl('http://192.0.2.1/cover.png', 40, 40, { role: 'row' })).toBe(
      'https://192.0.2.1/cover.png?param=96y96',
    )
  })

  it('uses role-specific request buckets rather than a universal 512px minimum', async () => {
    const { coverImageUrl } = await freshCoverImageModule()
    const source = 'http://img.test/cover.jpg?foo=bar&param=96y96'

    expect(coverImageUrl(source, 40, 40, { role: 'row', pixelRatio: 2 })).toBe(
      'https://img.test/cover.jpg?foo=bar&param=96y96',
    )
    expect(coverImageUrl(source, 48, 48, { role: 'player', pixelRatio: 2 })).toBe(
      'https://img.test/cover.jpg?foo=bar&param=128y128',
    )
    expect(coverImageUrl(source, 232, 232, { role: 'hero', pixelRatio: 2 })).toBe(
      'https://img.test/cover.jpg?foo=bar&param=512y512',
    )
    expect(coverImageUrl(source, 580, 580, { role: 'immersive', pixelRatio: 2 })).toBe(
      'https://img.test/cover.jpg?foo=bar&param=1024y1024',
    )
  })

  it('preserves the aspect ratio of a video request', async () => {
    const { coverImageUrl } = await freshCoverImageModule()

    expect(
      coverImageUrl('https://img.test/video.jpg', 464, 260, { role: 'video', pixelRatio: 2 }),
    ).toBe('https://img.test/video.jpg?param=960y538')
  })

  it('keeps video-card thumbnails smaller than full player posters', async () => {
    const { coverImageUrl } = await freshCoverImageModule()

    expect(
      coverImageUrl('https://img.test/video.jpg', 464, 260, {
        role: 'video-card',
        pixelRatio: 2,
      }),
    ).toBe('https://img.test/video.jpg?param=480y269')
  })

  it('can request an exact cacheable media artwork size', async () => {
    const { coverImageUrl } = await freshCoverImageModule()

    expect(
      coverImageUrl('https://img.test/cover.jpg?param=32y32', 512, 512, {
        role: 'media-session',
        exact: true,
        maxWidth: 512,
        minWidth: 512,
        pixelRatio: 1,
      }),
    ).toBe('https://img.test/cover.jpg?param=512y512')
  })

  it('falls back only to smaller requested artwork variants', async () => {
    const { coverImageCandidates } = await freshCoverImageModule()
    const candidates = coverImageCandidates('http://p1.music.126.net/hash/cover.jpg', 1024, 1024, {
      role: 'immersive',
      pixelRatio: 2,
    })

    expect(candidates[0]).toBe('https://p1.music.126.net/hash/cover.jpg?param=1024y1024')
    expect(candidates.some((url) => url.includes('param=1280y1280'))).toBe(false)
    expect(candidates.some((url) => url === 'https://p1.music.126.net/hash/cover.jpg')).toBe(false)
    expect(candidates.some((url) => url.includes('p2.music.126.net'))).toBe(true)
    expect(candidates.some((url) => url.startsWith('http://p1.music.126.net'))).toBe(false)
    expect(candidates.some((url) => url.includes('param=1920y1920'))).toBe(false)
  })

  it('requires an explicit opt-in before trying an unbounded original URL', async () => {
    const { coverImageCandidates } = await freshCoverImageModule()
    const source = 'https://img.test/master.jpg?param=3000y3000'

    const bounded = coverImageCandidates(source, 232, 232, { role: 'hero' })
    expect(bounded.some((url) => url === 'https://img.test/master.jpg')).toBe(false)

    const optedIn = coverImageCandidates(source, 232, 232, {
      role: 'hero',
      allowOriginalFallback: true,
    })
    expect(optedIn.some((url) => url === 'https://img.test/master.jpg')).toBe(true)
  })

  it('keeps an opted-in original fallback on the canonical HTTPS source', async () => {
    const { coverImageCandidates } = await freshCoverImageModule()
    const candidates = coverImageCandidates('http://img.test/master.jpg', 40, 40, {
      role: 'row',
      allowOriginalFallback: true,
    })

    expect(candidates.some((url) => url === 'http://img.test/master.jpg')).toBe(false)
    expect(candidates.some((url) => url === 'https://img.test/master.jpg')).toBe(true)
  })
})

describe('cover image preloading', () => {
  it('keeps one active and two pending speculative image requests', async () => {
    const images: FakeImageRecord[] = []
    vi.stubGlobal('Image', createFakeImageClass(images))
    try {
      const { preloadCoverImages } = await freshCoverImageModule()
      for (let index = 0; index < 5; index += 1) {
        preloadCoverImages(`https://img.test/preload-${index}.jpg`)
      }

      expect(images).toHaveLength(1)
      expect(images[0]?.src).toContain('preload-0.jpg?param=160y160')
      images[0]?.listeners.load?.()
      expect(images).toHaveLength(2)
      images[1]?.listeners.load?.()
      expect(images).toHaveLength(3)
      images[2]?.listeners.load?.()
      expect(images).toHaveLength(3)
      expect(images[0]?.src).toMatch(/^data:image\/gif/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not remember work rejected while the pending queue is full', async () => {
    const images: FakeImageRecord[] = []
    vi.stubGlobal('Image', createFakeImageClass(images))
    try {
      const { preloadCoverImages } = await freshCoverImageModule()
      for (let index = 0; index < 3; index += 1) {
        preloadCoverImages(`https://img.test/fill-${index}.jpg`)
      }
      preloadCoverImages('https://img.test/overflow.jpg')

      images[0]?.listeners.load?.()
      images[1]?.listeners.load?.()
      images[2]?.listeners.load?.()
      expect(
        images.some((image) => image.sources.some((url) => url.includes('overflow.jpg'))),
      ).toBe(false)

      preloadCoverImages('https://img.test/overflow.jpg')
      expect(images.some((image) => image.src.includes('overflow.jpg'))).toBe(true)
      images.find((image) => image.src.includes('overflow.jpg'))?.listeners.load?.()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('releases a hung speculative request before starting the next one', async () => {
    vi.useFakeTimers()
    const images: FakeImageRecord[] = []
    vi.stubGlobal('Image', createFakeImageClass(images))
    try {
      const { preloadCoverImages } = await freshCoverImageModule()
      preloadCoverImages('https://img.test/hung.jpg')
      preloadCoverImages('https://img.test/after-hung.jpg')
      expect(images).toHaveLength(1)

      vi.advanceTimersByTime(8_000)
      expect(images).toHaveLength(2)
      expect(images[1]?.src).toContain('after-hung.jpg')
      expect(images[0]?.src).toMatch(/^data:image\/gif/)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
