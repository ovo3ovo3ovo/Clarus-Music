import { describe, expect, it } from 'vitest'
import { activeLyricIndex, secondaryLyric, type LyricLine } from './lyrics'

const lines: readonly LyricLine[] = [
  { timeMs: 1_000, original: 'One', translation: '一', romanization: 'one' },
  { timeMs: 2_500, original: 'Two', translation: null, romanization: 'two' },
  { timeMs: 8_000, original: 'Three', translation: '三', romanization: null },
]

describe('lyrics domain', () => {
  it('finds the active line with a logarithmic boundary search', () => {
    expect(activeLyricIndex(lines, 999)).toBe(-1)
    expect(activeLyricIndex(lines, 1_000)).toBe(0)
    expect(activeLyricIndex(lines, 7_999)).toBe(1)
    expect(activeLyricIndex(lines, 50_000)).toBe(2)
  })

  it('selects only the requested secondary lyric', () => {
    expect(secondaryLyric(lines[0]!, 'translation')).toBe('一')
    expect(secondaryLyric(lines[0]!, 'romanization')).toBe('one')
    expect(secondaryLyric(lines[1]!, 'translation')).toBeNull()
  })
})
