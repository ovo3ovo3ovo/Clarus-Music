import { describe, expect, it } from 'vitest'
import { formatPlayCount } from './music-video'

describe('music video domain', () => {
  it('preserves the legacy localized play-count thresholds', () => {
    expect(formatPlayCount(232_199, 'zh-CN')).toBe('23.2万')
    expect(formatPlayCount(232_199, 'zh-TW')).toBe('23.2萬')
    expect(formatPlayCount(2_339_999, 'en')).toBe('2.33M')
    expect(formatPlayCount(2_339, 'tr')).toBe('2.33K')
    expect(formatPlayCount(0, 'en')).toBe('')
  })
})
