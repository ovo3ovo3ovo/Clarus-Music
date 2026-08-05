import { Howl } from 'howler'
import type {
  AudioEngine,
  AudioEngineEventMap,
  AudioEngineListener,
  AudioEngineState,
  AudioSource,
} from '@/features/player/domain/audio-engine'

type ListenerRegistry = {
  [K in keyof AudioEngineEventMap]: Set<AudioEngineListener<K>>
}

type HowlerHtml5Sound = {
  readonly _node?: HTMLAudioElement
}

type HowlWithHtml5Sounds = Howl & {
  readonly _sounds?: readonly HowlerHtml5Sound[]
}

function abortError(reason?: unknown): DOMException {
  return new DOMException(String(reason ?? 'Audio load aborted'), 'AbortError')
}

function normalizedError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' && reason.length > 0 ? reason : fallback)
}

export function audioFormatForSource(source: AudioSource): string {
  const mimeType = source.kind === 'bytes' || source.kind === 'managed-url' ? source.mimeType : null
  switch (mimeType) {
    case 'audio/flac':
      return 'flac'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/webm':
      return 'webm'
    case 'audio/mp4':
      return 'm4a'
    default:
      return 'mp3'
  }
}

export class HowlerAudioEngine implements AudioEngine {
  private readonly listeners: ListenerRegistry = {
    state: new Set(),
    duration: new Set(),
    time: new Set(),
    seeked: new Set(),
    volume: new Set(),
    error: new Set(),
  }

  private howl: Howl | null = null
  private currentState: AudioEngineState = 'idle'
  private ownedObjectUrl: string | null = null
  private ownedRelease: (() => void) | null = null
  private loadController: AbortController | null = null
  private outputDeviceId = 'default'
  private desiredVolume = 1
  private sourceFormat = 'mp3'
  private disposed = false

  get state(): AudioEngineState {
    return this.currentState
  }

  get currentTime(): number {
    const value = this.howl?.seek()
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  get duration(): number {
    const value = this.howl?.duration()
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  get volume(): number {
    const value = this.howl?.volume()
    return typeof value === 'number' && Number.isFinite(value) ? value : this.desiredVolume
  }

  get supportsOutputDeviceSelection(): boolean {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
  }

  async load(source: AudioSource, signal?: AbortSignal): Promise<void> {
    this.assertActive()
    this.cancelPendingLoad()
    this.releaseSource()
    if (signal?.aborted) {
      if (source.kind === 'managed-url') source.release()
      throw abortError(signal.reason)
    }

    const controller = new AbortController()
    this.loadController = controller
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    this.setState('loading')
    const url = this.createSourceUrl(source)
    this.sourceFormat = audioFormatForSource(source)

    try {
      await new Promise<void>((resolve, reject) => {
        const handleAbort = () => {
          this.howl?.unload()
          reject(abortError(controller.signal.reason))
        }
        controller.signal.addEventListener('abort', handleAbort, { once: true })
        const cleanup = () => controller.signal.removeEventListener('abort', handleAbort)

        const howl = new Howl({
          src: [url],
          html5: true,
          preload: true,
          format: [this.sourceFormat],
          volume: this.volume,
          onload: () => {
            cleanup()
            if (this.howl !== howl || controller.signal.aborted) return
            this.setState('ready')
            this.emit('duration', this.duration)
            void this.applyOutputDevice().catch((reason: unknown) => {
              this.emit('error', normalizedError(reason, 'Unable to select audio output device'))
            })
            resolve()
          },
          onloaderror: (_id, reason) => {
            cleanup()
            if (this.howl !== howl || controller.signal.aborted) return
            const error = normalizedError(reason, 'Unable to load audio')
            this.setState('error')
            this.emit('error', error)
            reject(error)
          },
          onplayerror: (_id, reason) => {
            if (this.howl !== howl) return
            const error = normalizedError(reason, 'Unable to play audio')
            this.setState('error')
            this.emit('error', error)
          },
          onplay: () => {
            if (this.howl === howl) this.setState('playing')
          },
          onpause: () => {
            if (this.howl === howl && this.currentState !== 'loading') this.setState('paused')
          },
          onstop: () => {
            if (this.howl === howl && this.currentState !== 'loading') this.setState('paused')
          },
          onend: () => {
            if (this.howl === howl) this.setState('ended')
          },
          onseek: () => {
            if (this.howl !== howl) return
            const value = this.currentTime
            this.emit('time', value)
            this.emit('seeked', value)
          },
          onvolume: () => {
            if (this.howl === howl) this.emit('volume', this.volume)
          },
        })
        this.howl = howl
      })
    } catch (error) {
      if (this.loadController === controller) this.releaseSource()
      throw error
    } finally {
      signal?.removeEventListener('abort', forwardAbort)
      if (this.loadController === controller) this.loadController = null
    }
  }

  async play(): Promise<void> {
    this.assertActive()
    const howl = this.howl
    if (howl === null) throw new Error('No audio source is loaded')
    if (howl.playing()) return
    await new Promise<void>((resolve, reject) => {
      const id = howl.play()
      const played = () => {
        howl.off('playerror', failed, id)
        resolve()
      }
      const failed = (_soundId: number, reason: unknown) => {
        howl.off('play', played, id)
        reject(normalizedError(reason, 'Unable to play audio'))
      }
      howl.once('play', played, id)
      howl.once('playerror', failed, id)
    })
  }

  pause(): void {
    if (this.disposed) return
    this.howl?.pause()
  }

  seek(seconds: number): void {
    this.assertActive()
    const howl = this.howl
    if (howl === null) return
    const upperBound = this.duration || Number.POSITIVE_INFINITY
    howl.seek(Math.min(Math.max(seconds, 0), upperBound))
  }

  setVolume(value: number): void {
    this.assertActive()
    this.desiredVolume = Math.min(Math.max(value, 0), 1)
    this.howl?.volume(this.desiredVolume)
    if (this.howl === null) this.emit('volume', this.desiredVolume)
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.assertActive()
    this.outputDeviceId = deviceId
    if (!this.supportsOutputDeviceSelection) {
      if (deviceId === 'default') return
      throw new Error('Audio output device selection is unavailable')
    }
    await this.applyOutputDevice()
  }

  subscribe<K extends keyof AudioEngineEventMap>(
    event: K,
    listener: AudioEngineListener<K>,
  ): () => void {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPendingLoad()
    this.releaseSource()
    for (const registry of Object.values(this.listeners)) registry.clear()
    this.currentState = 'idle'
  }

  private createSourceUrl(source: AudioSource): string {
    if (source.kind === 'remote') return source.url
    if (source.kind === 'managed-url') {
      this.ownedRelease = source.release
      return source.url
    }
    // Electron/Chromium could sniff the legacy untyped Blob. WKWebView requires
    // the real media type or valid FLAC bytes are rejected before decoding.
    const url = URL.createObjectURL(new Blob([source.bytes], { type: source.mimeType }))
    this.ownedObjectUrl = url
    return url
  }

  private async applyOutputDevice(): Promise<void> {
    const sound = (this.howl as HowlWithHtml5Sounds | null)?._sounds?.[0]
    const node = sound?._node
    const setSinkId = node?.setSinkId
    if (typeof setSinkId !== 'function') {
      if (this.outputDeviceId === 'default') return
      throw new Error('Audio output device selection is unavailable')
    }
    await setSinkId.call(node, this.outputDeviceId)
  }

  private cancelPendingLoad(): void {
    this.loadController?.abort('Audio source changed')
    this.loadController = null
  }

  private releaseSource(): void {
    this.howl?.unload()
    this.howl = null
    if (this.ownedObjectUrl !== null) {
      URL.revokeObjectURL(this.ownedObjectUrl)
      this.ownedObjectUrl = null
    }
    const release = this.ownedRelease
    this.ownedRelease = null
    release?.()
  }

  private setState(state: AudioEngineState): void {
    if (this.currentState === state) return
    this.currentState = state
    this.emit('state', state)
  }

  private emit<K extends keyof AudioEngineEventMap>(event: K, value: AudioEngineEventMap[K]): void {
    for (const listener of this.listeners[event]) listener(value)
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Audio engine has been disposed')
  }
}
