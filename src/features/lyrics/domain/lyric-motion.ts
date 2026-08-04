import type { LyricLine, LyricWord } from './lyrics'

export interface ScrollSpringState {
  readonly position: number
  readonly velocity: number
}

export interface LineVisualState {
  readonly distance: number
  readonly opacity: number
  readonly blurPx: number
}

const MAX_FRAME_MS = 34
const SPRING_STIFFNESS = 185
const SPRING_DAMPING = 26

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Advances the lyric viewport toward its latest target without queueing a
 * second browser animation. A new target keeps the current position and
 * velocity, so a quick seek changes direction naturally instead of jumping
 * from the old animation's starting point.
 */
export function advanceScrollSpring(
  state: ScrollSpringState,
  target: number,
  elapsedMs: number,
  reducedMotion = false,
): ScrollSpringState {
  if (reducedMotion || !Number.isFinite(target)) {
    return { position: target, velocity: 0 }
  }

  const elapsedSeconds = clamp(elapsedMs, 0, MAX_FRAME_MS) / 1_000
  if (elapsedSeconds === 0) return state

  const displacement = target - state.position
  const acceleration = displacement * SPRING_STIFFNESS - state.velocity * SPRING_DAMPING
  const velocity = state.velocity + acceleration * elapsedSeconds
  const position = state.position + velocity * elapsedSeconds

  if (Math.abs(target - position) < 0.2 && Math.abs(velocity) < 0.2) {
    return { position: target, velocity: 0 }
  }
  return { position, velocity }
}

/**
 * Computes the scrollTop that puts a line at a stable visual anchor. The
 * caller clamps this value against the current scrollable range because the
 * range can change after images or translated lines finish measuring.
 */
export function centeredScrollTarget(
  viewportHeight: number,
  scrollHeight: number,
  lineTop: number,
  lineHeight: number,
  alignment = 0.5,
): number {
  const safeViewportHeight = Math.max(0, viewportHeight)
  const safeScrollHeight = Math.max(safeViewportHeight, scrollHeight)
  const safeLineHeight = Math.max(0, lineHeight)
  const rawTarget = lineTop - safeViewportHeight * alignment + safeLineHeight * alignment
  return clamp(rawTarget, 0, Math.max(0, safeScrollHeight - safeViewportHeight))
}

/**
 * Distance-based presentation values keep the current line legible while
 * giving surrounding lines a quiet Apple-Music-like depth hierarchy.
 */
export function lineVisualState(
  index: number,
  activeIndex: number,
  userScrolling = false,
  focusIndex: number | null = null,
): LineVisualState {
  const visualIndex = focusIndex !== null && focusIndex >= 0 ? focusIndex : activeIndex
  if (visualIndex < 0) {
    return { distance: 0, opacity: 0.58, blurPx: 0 }
  }

  const distance = Math.abs(index - visualIndex)
  const opacity = userScrolling
    ? clamp(1 - distance * 0.18, 0.24, 1)
    : clamp(1 - distance * 0.135, 0.16, 1)
  const blurPx = userScrolling
    ? clamp(distance * 0.92, 0, 4.8)
    : clamp(distance * 1.15, 0, 6.5)
  return { distance, opacity, blurPx }
}

/**
 * Calculates the fill amount for one timed word. Lines without word timing
 * simply render their original text and never call this function.
 */
export function wordFillPercent(word: LyricWord, timeMs: number): number {
  if (!Number.isFinite(timeMs) || timeMs <= word.startMs) return 0
  if (timeMs >= word.endMs) return 100
  const duration = word.endMs - word.startMs
  return duration > 0 ? clamp(((timeMs - word.startMs) / duration) * 100, 0, 100) : 100
}

/**
 * Keeps a line's word timings inside its own interval. This protects the DOM
 * highlighter from malformed server data while leaving line-level playback
 * fully usable.
 */
export function usableWords(line: LyricLine): readonly LyricWord[] {
  if (!line.words || line.words.length === 0) return []
  return line.words.filter(
    (word) =>
      Number.isFinite(word.startMs) &&
      Number.isFinite(word.endMs) &&
      word.endMs > word.startMs &&
      word.text.length > 0,
  )
}
