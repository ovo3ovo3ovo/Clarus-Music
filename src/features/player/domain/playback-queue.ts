import type { RepeatMode } from '@/types/music'

export type QueueDirection = 'next' | 'previous'
export type QueueAdvanceReason = 'manual' | 'ended'

export interface QueuePosition {
  readonly length: number
  readonly currentIndex: number
  readonly repeatMode: RepeatMode
  readonly reversed: boolean
}

function sequentialOrder(length: number): readonly number[] {
  return Array.from({ length }, (_, index) => index)
}

function validOrder(order: readonly number[], length: number): boolean {
  return (
    order.length === length &&
    new Set(order).size === length &&
    order.every((index) => Number.isSafeInteger(index) && index >= 0 && index < length)
  )
}

function shuffleIndices(indices: number[], random: () => number): readonly number[] {
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const randomValue = random()
    const boundedRandom = Number.isFinite(randomValue)
      ? Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON)
      : 0
    const swapIndex = Math.floor(boundedRandom * (index + 1))
    const value = indices[index]
    indices[index] = indices[swapIndex] as number
    indices[swapIndex] = value as number
  }
  return indices
}

function wrappedIndex(index: number, length: number): number {
  return ((index % length) + length) % length
}

/**
 * Resolves a queue move without mutating playback state. Manual navigation
 * ignores repeat-one; a natural track ending honors it.
 */
export function resolveQueueIndex(
  position: QueuePosition,
  direction: QueueDirection,
  reason: QueueAdvanceReason = 'manual',
): number | null {
  const { currentIndex, length, repeatMode, reversed } = position
  if (length <= 0 || currentIndex < 0 || currentIndex >= length) return null
  if (reason === 'ended' && repeatMode === 'one') return currentIndex

  const logicalDelta = direction === 'next' ? 1 : -1
  const candidate = currentIndex + (reversed ? -logicalDelta : logicalDelta)
  if (candidate >= 0 && candidate < length) return candidate
  return repeatMode === 'all' ? wrappedIndex(candidate, length) : null
}

export function resolveQueueTrackIndex(
  position: QueuePosition,
  order: readonly number[],
  direction: QueueDirection,
  reason: QueueAdvanceReason = 'manual',
): number | null {
  const playbackOrder = validOrder(order, position.length)
    ? order
    : sequentialOrder(position.length)
  const cursor = playbackOrder.indexOf(position.currentIndex)
  if (cursor < 0) return null
  const nextCursor = resolveQueueIndex(
    { ...position, length: playbackOrder.length, currentIndex: cursor },
    direction,
    reason,
  )
  return nextCursor === null ? null : (playbackOrder[nextCursor] ?? null)
}

export function upcomingQueueIndices(
  length: number,
  currentIndex: number,
  order: readonly number[],
  reversed: boolean,
  limit = 99,
): readonly number[] {
  if (length <= 0 || limit <= 0) return []
  const playbackOrder = validOrder(order, length) ? order : sequentialOrder(length)
  const cursor = playbackOrder.indexOf(currentIndex)
  if (cursor < 0) return []
  return (
    reversed ? playbackOrder.slice(0, cursor).reverse() : playbackOrder.slice(cursor + 1)
  ).slice(0, limit)
}

/** Fisher-Yates order with the current track pinned first for immediate parity. */
export function createShuffledOrder(
  length: number,
  currentIndex: number,
  random: () => number = Math.random,
  currentAtEnd = false,
): readonly number[] {
  if (length <= 0 || currentIndex < 0 || currentIndex >= length) return []

  const order = Array.from({ length }, (_, index) => index).filter(
    (index) => index !== currentIndex,
  )
  shuffleIndices(order, random)
  if (currentAtEnd) order.push(currentIndex)
  else order.unshift(currentIndex)
  return order
}

/** Extends a valid shuffle without changing the order already shown to the user. */
export function extendShuffledOrder(
  order: readonly number[],
  previousLength: number,
  addedLength: number,
  currentIndex: number,
  reversed: boolean,
  random: () => number = Math.random,
): readonly number[] {
  const nextLength = previousLength + Math.max(addedLength, 0)
  if (!validOrder(order, previousLength)) {
    return createShuffledOrder(nextLength, currentIndex, random, reversed)
  }
  if (addedLength <= 0) return order

  const additions = Array.from({ length: addedLength }, (_, index) => previousLength + index)
  shuffleIndices(additions, random)
  return reversed ? [...additions, ...order] : [...order, ...additions]
}

export function pinCurrentInOrder(
  order: readonly number[],
  length: number,
  currentIndex: number,
  currentAtEnd: boolean,
): readonly number[] {
  const playbackOrder = validOrder(order, length) ? order : sequentialOrder(length)
  if (currentIndex < 0 || currentIndex >= length) return playbackOrder
  const withoutCurrent = playbackOrder.filter((index) => index !== currentIndex)
  return currentAtEnd ? [...withoutCurrent, currentIndex] : [currentIndex, ...withoutCurrent]
}

export function cycleRepeatMode(mode: RepeatMode): RepeatMode {
  if (mode === 'off') return 'all'
  if (mode === 'all') return 'one'
  return 'off'
}
