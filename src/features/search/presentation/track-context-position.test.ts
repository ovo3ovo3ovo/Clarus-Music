import { describe, expect, it } from 'vitest'
import { trackContextPosition } from './track-context-position'

describe('track context menu position', () => {
  it('keeps the menu within all viewport edges', () => {
    expect(trackContextPosition(-20, -10, 1200, 800)).toEqual({ x: 8, y: 8 })
    expect(trackContextPosition(1190, 790, 1200, 800)).toEqual({ x: 968, y: 632 })
    expect(trackContextPosition(400, 300, 1200, 800)).toEqual({ x: 400, y: 300 })
  })
})
