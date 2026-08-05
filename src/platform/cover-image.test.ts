import { describe, expect, it, vi } from 'vitest'
import { coverImageCandidates, coverImageUrl, preloadCoverImages } from './cover-image'

describe('coverImageUrl', () => {
  it('replaces an existing low-resolution param with one Retina variant', () => {
    expect(coverImageUrl('http://img.test/cover.jpg?foo=bar&param=96y96', 224)).toBe(
      'https://img.test/cover.jpg?foo=bar&param=512y512',
    )
  })

  it('uses canonical high-resolution sizes for cards and detail artwork', () => {
    expect(coverImageUrl('https://img.test/cover.jpg', 512)).toBe(
      'https://img.test/cover.jpg?param=1024y1024',
    )
    expect(coverImageUrl('https://img.test/cover.jpg', 1024)).toBe(
      'https://img.test/cover.jpg?param=1600y1600',
    )
  })

  it('preserves the aspect ratio of landscape artwork', () => {
    expect(coverImageUrl('https://img.test/video.jpg', 464, 260)).toBe(
      'https://img.test/video.jpg?param=960y538',
    )
  })

  it('can request an exact cacheable media artwork size', () => {
    expect(
      coverImageUrl('https://img.test/cover.jpg?param=32y32', 224, 224, {
        exact: true,
        maxWidth: 224,
        minWidth: 224,
        pixelRatio: 1,
      }),
    ).toBe('https://img.test/cover.jpg?param=224y224')
  })

  it('provides lower-resolution and original URL fallbacks for failed artwork', () => {
    const candidates = coverImageCandidates('http://p1.music.126.net/hash/cover.jpg', 1024)

    expect(candidates[0]).toBe('https://p1.music.126.net/hash/cover.jpg?param=1600y1600')
    expect(candidates.some((url) => url.includes('param=1024y1024'))).toBe(true)
    expect(candidates.some((url) => url === 'https://p1.music.126.net/hash/cover.jpg')).toBe(true)
    expect(candidates.some((url) => url.includes('p2.music.126.net'))).toBe(true)
    expect(candidates.some((url) => url.startsWith('http://p1.music.126.net'))).toBe(true)
  })
})

describe('cover image preloading', () => {
  it('limits concurrent speculative image requests and starts queued work on release', () => {
    const images: Array<{ listeners: Record<string, () => void>; src: string }> = []
    class FakeImage {
      readonly listeners: Record<string, () => void> = {}
      src = ''

      addEventListener(event: string, listener: () => void): void {
        this.listeners[event] = listener
      }

      constructor() {
        images.push(this)
      }
    }
    vi.stubGlobal('Image', FakeImage)
    try {
      for (let index = 0; index < 5; index += 1) {
        preloadCoverImages(`https://img.test/preload-${index}.jpg`)
      }
      expect(images.length).toBe(4)
      images[0]?.listeners.load()
      expect(images.length).toBe(5)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
