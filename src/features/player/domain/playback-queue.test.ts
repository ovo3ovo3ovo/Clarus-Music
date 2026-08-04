import { describe, expect, it } from 'vitest'
import {
  createShuffledOrder,
  cycleRepeatMode,
  extendShuffledOrder,
  pinCurrentInOrder,
  resolveQueueIndex,
  resolveQueueTrackIndex,
  upcomingQueueIndices,
} from './playback-queue'

describe('resolveQueueIndex', () => {
  const base = { length: 3, currentIndex: 1, repeatMode: 'off' as const, reversed: false }

  it('moves in both directions', () => {
    expect(resolveQueueIndex(base, 'next')).toBe(2)
    expect(resolveQueueIndex(base, 'previous')).toBe(0)
  })

  it('inverts navigation in reversed mode', () => {
    const reversed = { ...base, reversed: true }
    expect(resolveQueueIndex(reversed, 'next')).toBe(0)
    expect(resolveQueueIndex(reversed, 'previous')).toBe(2)
  })

  it('stops at queue boundaries when repeat is off', () => {
    expect(resolveQueueIndex({ ...base, currentIndex: 2 }, 'next')).toBeNull()
    expect(resolveQueueIndex({ ...base, currentIndex: 0 }, 'previous')).toBeNull()
  })

  it('wraps both normal and reversed boundaries in repeat-all mode', () => {
    const repeatAll = { ...base, repeatMode: 'all' as const }
    expect(resolveQueueIndex({ ...repeatAll, currentIndex: 2 }, 'next')).toBe(0)
    expect(resolveQueueIndex({ ...repeatAll, currentIndex: 0, reversed: true }, 'next')).toBe(2)
  })

  it('repeats one only after a natural ending', () => {
    const repeatOne = { ...base, repeatMode: 'one' as const }
    expect(resolveQueueIndex(repeatOne, 'next', 'ended')).toBe(1)
    expect(resolveQueueIndex(repeatOne, 'next', 'manual')).toBe(2)
  })

  it('rejects empty and invalid positions', () => {
    expect(resolveQueueIndex({ ...base, length: 0, currentIndex: -1 }, 'next')).toBeNull()
    expect(resolveQueueIndex({ ...base, currentIndex: 3 }, 'next')).toBeNull()
  })
})

describe('createShuffledOrder', () => {
  it('pins the current item and returns every index exactly once', () => {
    const values = [0.75, 0.1, 0.5]
    let cursor = 0
    const order = createShuffledOrder(5, 2, () => values[cursor++] ?? 0)

    expect(order[0]).toBe(2)
    expect([...order].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4])
  })

  it('bounds invalid random implementations', () => {
    expect(createShuffledOrder(3, 1, () => 1)).toHaveLength(3)
    expect(createShuffledOrder(3, 1, () => Number.NaN)).toHaveLength(3)
  })

  it('can pin the current item at the reversed boundary', () => {
    const order = createShuffledOrder(4, 1, () => 0, true)
    expect(order.at(-1)).toBe(1)
    expect([...order].sort((left, right) => left - right)).toEqual([0, 1, 2, 3])
  })
})

describe('extendShuffledOrder', () => {
  it('preserves the existing future and shuffles only appended indices', () => {
    expect(extendShuffledOrder([0, 2, 3, 1], 4, 2, 0, false, () => 0)).toEqual([0, 2, 3, 1, 5, 4])
  })

  it('places additions after the existing future in reversed playback direction', () => {
    const extended = extendShuffledOrder([2, 3, 1, 0], 4, 2, 0, true, () => 0)
    expect(extended).toEqual([5, 4, 2, 3, 1, 0])
    expect(upcomingQueueIndices(6, 0, extended, true)).toEqual([1, 3, 2, 4, 5])
  })

  it('rebuilds a malformed previous order for the complete queue', () => {
    const extended = extendShuffledOrder([0, 0], 2, 1, 0, false, () => 0)
    expect([...extended].sort((left, right) => left - right)).toEqual([0, 1, 2])
  })
})

describe('pinCurrentInOrder', () => {
  it('moves only the current index when the playback direction changes', () => {
    expect(pinCurrentInOrder([0, 2, 3, 1], 4, 0, true)).toEqual([2, 3, 1, 0])
    expect(pinCurrentInOrder([2, 3, 1, 0], 4, 0, false)).toEqual([0, 2, 3, 1])
  })
})

describe('ordered queue helpers', () => {
  const position = { length: 4, currentIndex: 2, repeatMode: 'off' as const, reversed: false }

  it('moves through a validated shuffled index order', () => {
    const order = [2, 0, 3, 1]
    expect(resolveQueueTrackIndex(position, order, 'next')).toBe(0)
    expect(resolveQueueTrackIndex({ ...position, reversed: true }, order, 'next')).toBeNull()
  })

  it('falls back to sequential order when an index order is malformed', () => {
    expect(resolveQueueTrackIndex(position, [2, 2, 1, 0], 'next')).toBe(3)
  })

  it('returns only the bounded future in normal and reversed order', () => {
    expect(upcomingQueueIndices(5, 1, [], false, 2)).toEqual([2, 3])
    expect(upcomingQueueIndices(5, 3, [], true, 2)).toEqual([2, 1])
    expect(upcomingQueueIndices(4, 2, [2, 0, 3, 1], false)).toEqual([0, 3, 1])
  })
})

describe('cycleRepeatMode', () => {
  it('cycles off, all, one, off', () => {
    expect(cycleRepeatMode('off')).toBe('all')
    expect(cycleRepeatMode('all')).toBe('one')
    expect(cycleRepeatMode('one')).toBe('off')
  })
})
