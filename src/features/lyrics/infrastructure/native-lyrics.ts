import { invoke } from '@tauri-apps/api/core'
import { desktop } from '@/platform/desktop'
import { cancellableInvoke, isRecord, type InvokeCommand } from '@/platform/native-ipc'
import type { LyricLine, LyricWord, TrackLyrics } from '../domain/lyrics'

const MAX_WORDS_PER_LINE = 512
const MAX_WORD_CHARS = 1_024

function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return undefined
  return value
}

function mapWords(value: unknown): readonly LyricWord[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > MAX_WORDS_PER_LINE) return undefined
  const words: LyricWord[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined
    const text = candidate.text
    const startMs = candidate.startMs
    const endMs = candidate.endMs
    if (
      typeof startMs !== 'number' ||
      !Number.isSafeInteger(startMs) ||
      startMs < 0 ||
      typeof endMs !== 'number' ||
      !Number.isSafeInteger(endMs) ||
      endMs <= startMs ||
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > MAX_WORD_CHARS
    ) {
      return undefined
    }
    const previous = words.at(-1)
    if (previous && startMs < previous.startMs) return undefined
    words.push({ startMs, endMs, text })
  }
  return words.length > 0 ? words : undefined
}

function mapLine(value: unknown): LyricLine | null {
  if (!isRecord(value)) return null
  const translation = optionalText(value.translation)
  const romanization = optionalText(value.romanization)
  const words = mapWords(value.words)
  if (
    !Number.isSafeInteger(value.timeMs) ||
    (value.timeMs as number) < 0 ||
    typeof value.original !== 'string' ||
    value.original.length === 0 ||
    value.original.length > 4_096 ||
    translation === undefined ||
    romanization === undefined ||
    (value.words !== undefined && value.words !== null && words === undefined)
  ) {
    return null
  }
  return {
    timeMs: value.timeMs as number,
    original: value.original,
    translation,
    romanization,
    ...(words ? { words } : {}),
  }
}

export function mapNativeLyrics(value: unknown): TrackLyrics {
  if (
    !isRecord(value) ||
    !Array.isArray(value.lines) ||
    value.lines.length > 1_000 ||
    typeof value.instrumental !== 'boolean'
  ) {
    throw new Error('Invalid lyrics response')
  }
  const lines = value.lines.map(mapLine)
  if (lines.some((line) => line === null)) throw new Error('Invalid lyric line')
  const mapped = lines as LyricLine[]
  if (mapped.some((line, index) => index > 0 && line.timeMs <= mapped[index - 1]!.timeMs)) {
    throw new Error('Lyric timestamps must be strictly increasing')
  }
  if (value.instrumental && mapped.length > 0) {
    throw new Error('Instrumental lyrics must not contain timed lines')
  }
  return { lines: mapped, instrumental: value.instrumental }
}

export interface LyricsGateway {
  load(trackId: number, signal?: AbortSignal): Promise<TrackLyrics>
}

export class NativeLyricsGateway implements LyricsGateway {
  private readonly invokeCommand: InvokeCommand
  private readonly createRequestId: () => string
  private readonly isDesktop: boolean

  constructor(
    invokeCommand: InvokeCommand = invoke,
    createRequestId: () => string = () => crypto.randomUUID(),
    isDesktop = desktop.isDesktop,
  ) {
    this.invokeCommand = invokeCommand
    this.createRequestId = createRequestId
    this.isDesktop = isDesktop
  }

  async load(trackId: number, signal?: AbortSignal): Promise<TrackLyrics> {
    if (!Number.isSafeInteger(trackId) || trackId <= 0) throw new Error('Invalid track ID')
    const result = await cancellableInvoke<unknown>({
      invokeCommand: this.invokeCommand,
      createRequestId: this.createRequestId,
      isDesktop: this.isDesktop,
      desktopError: 'Lyrics require the desktop app',
      abortMessage: 'Lyrics request aborted',
      command: 'track_lyrics',
      args: { trackId },
      signal,
    })
    return mapNativeLyrics(result)
  }
}
