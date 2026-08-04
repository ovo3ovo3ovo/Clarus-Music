import { describe, expect, it } from 'vitest'
import { formatCacheBytes } from './audio-cache'

describe('formatCacheBytes', () => {
  it('formats bounded byte counts without exposing invalid values', () => {
    expect(formatCacheBytes(0)).toBe('0 B')
    expect(formatCacheBytes(Number.NaN)).toBe('0 B')
    expect(formatCacheBytes(1536)).toBe('1.50 KB')
    expect(formatCacheBytes(8 * 1024 ** 3)).toBe('8.00 GB')
  })
})
