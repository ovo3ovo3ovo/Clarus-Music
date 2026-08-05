import { describe, expect, it } from 'vitest'
import {
  advanceScrollSpring,
  centeredScrollTarget,
  lineVisualState,
  nearestLyricCenterIndex,
  usableWords,
  wordFillPercent,
} from './lyric-motion'
import type { LyricLine } from './lyrics'

describe('lyric motion', () => {
  it('moves a spring toward a replacement target without jumping to its origin', () => {
    const first = advanceScrollSpring({ position: 0, velocity: 0 }, 400, 16)
    const redirected = advanceScrollSpring(first, 80, 16)

    expect(first.position).toBeGreaterThan(0)
    expect(redirected.position).toBeGreaterThan(first.position)
    expect(redirected.position).toBeLessThan(400)
  })

  it('snaps deterministically when reduced motion is requested', () => {
    expect(advanceScrollSpring({ position: 12, velocity: 90 }, 240, 16, true)).toEqual({
      position: 240,
      velocity: 0,
    })
  })

  it('centers a measured line while respecting the scrollable range', () => {
    expect(centeredScrollTarget(600, 2_000, 800, 80)).toBe(540)
    expect(centeredScrollTarget(600, 2_000, 0, 80)).toBe(0)
    expect(centeredScrollTarget(600, 2_000, 1_900, 80)).toBe(1_400)
  })

  it('finds the nearest cached lyric center without scanning every line', () => {
    const centers = [
      { index: 0, center: 100 },
      { index: 1, center: 240 },
      { index: 2, center: 390 },
      { index: 3, center: 610 },
    ]

    expect(nearestLyricCenterIndex(centers, 20)).toBe(0)
    expect(nearestLyricCenterIndex(centers, 300)).toBe(1)
    expect(nearestLyricCenterIndex(centers, 500)).toBe(2)
    expect(nearestLyricCenterIndex(centers, 900)).toBe(3)
    expect(nearestLyricCenterIndex([], 300)).toBeNull()
  })

  it('derives depth hierarchy and word fill from distance and time', () => {
    const active = lineVisualState(4, 4)
    const distant = lineVisualState(7, 4)
    expect(active.opacity).toBe(1)
    expect(distant.opacity).toBeLessThan(active.opacity)
    expect(distant.blurPx).toBeGreaterThan(0)
    expect(distant).not.toHaveProperty('offsetPx')
    expect(distant).not.toHaveProperty('scale')
    expect(lineVisualState(7, 4, true, 7).blurPx).toBe(0)
    expect(lineVisualState(7, 4, true, 7).opacity).toBe(1)
    expect(wordFillPercent({ startMs: 1_000, endMs: 2_000, text: 'word' }, 1_500)).toBe(50)
  })

  it('filters malformed word timing without affecting line playback', () => {
    const line: LyricLine = {
      timeMs: 1_000,
      original: 'Hello',
      translation: null,
      romanization: null,
      words: [
        { startMs: 1_000, endMs: 1_500, text: 'Hel' },
        { startMs: 1_500, endMs: 1_500, text: 'invalid' },
      ],
    }
    expect(usableWords(line)).toEqual([{ startMs: 1_000, endMs: 1_500, text: 'Hel' }])
  })
})
