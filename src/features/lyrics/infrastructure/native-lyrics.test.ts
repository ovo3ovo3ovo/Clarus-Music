import { describe, expect, it, vi } from 'vitest'
import { mapNativeLyrics, NativeLyricsGateway } from './native-lyrics'

describe('native lyrics gateway', () => {
  it('maps only bounded, strictly ordered lyric lines', () => {
    expect(
      mapNativeLyrics({
        instrumental: false,
        lines: [
          {
            timeMs: 1_000,
            original: 'Original',
            translation: 'Translation',
            romanization: null,
          },
          {
            timeMs: 2_000,
            original: 'Second',
            translation: null,
            romanization: 'Second romanized',
          },
        ],
      }),
    ).toMatchObject({ lines: [{ timeMs: 1_000 }, { timeMs: 2_000 }] })

    expect(() =>
      mapNativeLyrics({
        instrumental: false,
        lines: [
          { timeMs: 2_000, original: 'Two', translation: null, romanization: null },
          { timeMs: 1_000, original: 'One', translation: null, romanization: null },
        ],
      }),
    ).toThrow('strictly increasing')
  })

  it('keeps optional word timing while remaining compatible with legacy lines', () => {
    const mapped = mapNativeLyrics({
      instrumental: false,
      lines: [
        {
          timeMs: 1_000,
          original: 'Hello',
          translation: null,
          romanization: null,
          words: [
            { startMs: 1_000, endMs: 1_400, text: 'Hel' },
            { startMs: 1_400, endMs: 1_800, text: 'lo' },
          ],
        },
        { timeMs: 2_000, original: 'Legacy', translation: null, romanization: null },
      ],
    })

    expect(mapped.lines[0]?.words).toHaveLength(2)
    expect(mapped.lines[1]?.words).toBeUndefined()
  })

  it('cancels the native request when its owner aborts', async () => {
    let rejectLyrics: ((reason?: unknown) => void) | null = null
    const invokeCommand = vi.fn(<T>(command: string) => {
      if (command === 'cancel_music_request') {
        rejectLyrics?.(new Error('Native request cancelled'))
        return Promise.resolve(true as T)
      }
      return new Promise<T>((_, reject) => {
        rejectLyrics = reject
      })
    })
    const gateway = new NativeLyricsGateway(
      invokeCommand as unknown as ConstructorParameters<typeof NativeLyricsGateway>[0],
      () => 'lyrics-1',
      true,
    )
    const controller = new AbortController()
    const pending = gateway.load(10, controller.signal)
    controller.abort('closed')

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(invokeCommand).toHaveBeenCalledWith('cancel_music_request', {
      requestId: 'lyrics-1',
    })
  })
})
