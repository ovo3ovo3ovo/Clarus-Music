export type LyricMode = 'translation' | 'romanization'

/**
 * Optional word-level timing supplied by providers that expose YRC-style
 * karaoke data. The line-level timestamp remains the source of truth when a
 * provider does not include this field.
 */
export interface LyricWord {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

export interface LyricLine {
  readonly timeMs: number
  readonly original: string
  readonly translation: string | null
  readonly romanization: string | null
  readonly words?: readonly LyricWord[]
}

export interface TrackLyrics {
  readonly lines: readonly LyricLine[]
  readonly instrumental: boolean
}

export function hasTranslation(lyrics: TrackLyrics): boolean {
  return lyrics.lines.some(({ translation }) => translation !== null)
}

export function hasRomanization(lyrics: TrackLyrics): boolean {
  return lyrics.lines.some(({ romanization }) => romanization !== null)
}

export function activeLyricIndex(lines: readonly LyricLine[], progressMs: number): number {
  if (lines.length === 0 || !Number.isFinite(progressMs) || progressMs < lines[0]!.timeMs) return -1
  let low = 0
  let high = lines.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (lines[middle]!.timeMs <= progressMs) low = middle + 1
    else high = middle - 1
  }
  return high
}

export function secondaryLyric(line: LyricLine, mode: LyricMode): string | null {
  return mode === 'translation' ? line.translation : line.romanization
}
