import { describe, expect, it, vi } from 'vitest'
import { HtmlAudioEngine } from './html-audio-engine'

class FakeAudioElement extends EventTarget {
  src = ''
  preload = ''
  currentTime = 0
  duration = 180
  volume = 1
  paused = true
  error: MediaError | null = null
  readonly load = vi.fn()
  readonly setSinkId = vi.fn(async () => undefined)

  async play(): Promise<void> {
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }

  finishMetadata(): void {
    this.dispatchEvent(new Event('loadedmetadata'))
  }
}

function createEngine(): { engine: HtmlAudioEngine; audio: FakeAudioElement } {
  const audio = new FakeAudioElement()
  const engine = new HtmlAudioEngine(() => audio as unknown as HTMLAudioElement)
  return { engine, audio }
}

describe('single HTML audio engine', () => {
  it('reuses one metadata-only media element across track replacements', async () => {
    const { engine, audio } = createEngine()
    const first = engine.load({ kind: 'remote', url: 'https://audio.test/one.mp3' })
    expect(audio.preload).toBe('metadata')
    expect(audio.src).toBe('https://audio.test/one.mp3')
    audio.finishMetadata()
    await first

    const second = engine.load({ kind: 'remote', url: 'https://audio.test/two.mp3' })
    audio.finishMetadata()
    await second
    expect(audio.src).toBe('https://audio.test/two.mp3')
    expect(audio.load).toHaveBeenCalledTimes(4)
    engine.dispose()
  })

  it('releases a managed source when load is already aborted', async () => {
    const release = vi.fn()
    const controller = new AbortController()
    controller.abort('superseded')
    const { engine } = createEngine()

    await expect(
      engine.load(
        {
          kind: 'managed-url',
          url: 'http://127.0.0.1:1234/v1/audio/audio-cache-1?token=secret',
          mimeType: 'audio/mpeg',
          release,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(release).toHaveBeenCalledOnce()
    engine.dispose()
  })

  it('holds an adopted stream lease until replacement or disposal', async () => {
    const release = vi.fn()
    const controller = new AbortController()
    const { engine, audio } = createEngine()
    const loading = engine.load(
      {
        kind: 'managed-url',
        url: 'http://127.0.0.1:1234/v1/audio/audio-cache-1?token=secret',
        mimeType: 'audio/mpeg',
        release,
      },
      controller.signal,
    )
    audio.finishMetadata()
    await loading

    controller.abort('navigation superseded')
    expect(release).not.toHaveBeenCalled()
    engine.dispose()
    expect(release).toHaveBeenCalledOnce()
  })

  it('forwards playback, seeking, duration and time from the same element', async () => {
    const { engine, audio } = createEngine()
    const states: string[] = []
    const times: number[] = []
    engine.subscribe('state', (state) => states.push(state))
    engine.subscribe('seeked', (time) => times.push(time))
    const loading = engine.load({ kind: 'remote', url: 'https://audio.test/one.mp3' })
    audio.finishMetadata()
    await loading
    await engine.play()
    engine.seek(42)
    audio.dispatchEvent(new Event('seeked'))

    expect(engine.duration).toBe(180)
    expect(states).toEqual(['loading', 'ready', 'playing'])
    expect(times).toEqual([42])
    engine.dispose()
  })
})
