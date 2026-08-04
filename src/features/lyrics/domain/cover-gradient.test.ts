import { describe, expect, it } from 'vitest'
import { fallbackCoverGradient, gradientFromRgba } from './cover-gradient'

describe('cover gradients', () => {
  it('derives a stable two-color gradient from opaque pixels', () => {
    const gradient = gradientFromRgba(new Uint8ClampedArray([200, 60, 80, 255, 180, 40, 60, 255]))
    expect(gradient).toMatch(/^linear-gradient\(to top left, hsl\(/)
    expect(gradient).toContain('hsl(')
  })

  it('ignores transparent pixels and provides a deterministic fallback', () => {
    expect(gradientFromRgba(new Uint8ClampedArray([1, 2, 3, 0]))).toBeNull()
    expect(fallbackCoverGradient(30)).toBe(fallbackCoverGradient(30))
  })
})
