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

type AudioElementFactory = () => HTMLAudioElement

function abortError(reason?: unknown): DOMException {
  return new DOMException(String(reason ?? 'Audio load aborted'), 'AbortError')
}

function mediaError(audio: HTMLAudioElement): Error {
  const code = audio.error?.code
  return new Error(code ? `Unable to load audio (media error ${code})` : 'Unable to load audio')
}

function defaultAudioElement(): HTMLAudioElement {
  return document.createElement('audio')
}

/**
 * One HTMLAudioElement owns playback for the entire application lifetime.
 * Replacing only its source avoids Howler's per-track media elements and keeps
 * WebKit on the native, byte-range-capable media path.
 */
export class HtmlAudioEngine implements AudioEngine {
  private readonly listeners: ListenerRegistry = {
    state: new Set(),
    duration: new Set(),
    time: new Set(),
    seeked: new Set(),
    volume: new Set(),
    error: new Set(),
  }

  private readonly audio: HTMLAudioElement
  private currentState: AudioEngineState = 'idle'
  private ownedRelease: (() => void) | null = null
  private loadController: AbortController | null = null
  private outputDeviceId = 'default'
  private desiredVolume = 1
  private disposed = false

  constructor(createAudioElement: AudioElementFactory = defaultAudioElement) {
    this.audio = createAudioElement()
    this.audio.preload = 'metadata'
    this.audio.volume = this.desiredVolume
    this.audio.addEventListener('play', this.handlePlay)
    this.audio.addEventListener('pause', this.handlePause)
    this.audio.addEventListener('ended', this.handleEnded)
    this.audio.addEventListener('timeupdate', this.handleTimeUpdate)
    this.audio.addEventListener('seeked', this.handleSeeked)
    this.audio.addEventListener('volumechange', this.handleVolumeChange)
    this.audio.addEventListener('error', this.handleRuntimeError)
  }

  get state(): AudioEngineState {
    return this.currentState
  }

  get currentTime(): number {
    return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0
  }

  get duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0
  }

  get volume(): number {
    return Number.isFinite(this.audio.volume) ? this.audio.volume : this.desiredVolume
  }

  get supportsOutputDeviceSelection(): boolean {
    return typeof this.audio.setSinkId === 'function'
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
    if (source.kind === 'managed-url') this.ownedRelease = source.release
    this.setState('loading')
    this.audio.preload = 'metadata'
    this.audio.src = source.url

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.audio.removeEventListener('loadedmetadata', handleMetadata)
          this.audio.removeEventListener('error', handleError)
          controller.signal.removeEventListener('abort', handleAbort)
        }
        const handleMetadata = () => {
          cleanup()
          if (this.loadController !== controller || controller.signal.aborted) return
          this.setState('ready')
          this.emit('duration', this.duration)
          void this.applyOutputDevice().catch((reason: unknown) => {
            const error = reason instanceof Error ? reason : new Error(String(reason))
            this.emit('error', error)
          })
          resolve()
        }
        const handleError = () => {
          cleanup()
          if (this.loadController !== controller || controller.signal.aborted) return
          const error = mediaError(this.audio)
          this.setState('error')
          reject(error)
        }
        const handleAbort = () => {
          cleanup()
          if (this.loadController === controller) this.resetElement()
          reject(abortError(controller.signal.reason))
        }
        this.audio.addEventListener('loadedmetadata', handleMetadata, { once: true })
        this.audio.addEventListener('error', handleError, { once: true })
        controller.signal.addEventListener('abort', handleAbort, { once: true })
        this.audio.load()
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
    if (!this.audio.src) throw new Error('No audio source is loaded')
    if (!this.audio.paused) return
    try {
      await this.audio.play()
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason))
      this.setState('error')
      this.emit('error', error)
      throw error
    }
  }

  pause(): void {
    if (!this.disposed) this.audio.pause()
  }

  seek(seconds: number): void {
    this.assertActive()
    if (!this.audio.src) return
    const upperBound = this.duration || Number.POSITIVE_INFINITY
    this.audio.currentTime = Math.min(Math.max(seconds, 0), upperBound)
  }

  setVolume(value: number): void {
    this.assertActive()
    this.desiredVolume = Math.min(Math.max(value, 0), 1)
    if (this.audio.volume === this.desiredVolume) return
    this.audio.volume = this.desiredVolume
    this.emit('volume', this.desiredVolume)
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
    this.audio.removeEventListener('play', this.handlePlay)
    this.audio.removeEventListener('pause', this.handlePause)
    this.audio.removeEventListener('ended', this.handleEnded)
    this.audio.removeEventListener('timeupdate', this.handleTimeUpdate)
    this.audio.removeEventListener('seeked', this.handleSeeked)
    this.audio.removeEventListener('volumechange', this.handleVolumeChange)
    this.audio.removeEventListener('error', this.handleRuntimeError)
    for (const registry of Object.values(this.listeners)) registry.clear()
    this.currentState = 'idle'
  }

  private readonly handlePlay = () => this.setState('playing')
  private readonly handlePause = () => {
    if (!this.disposed && this.currentState !== 'loading' && this.currentState !== 'idle') {
      this.setState('paused')
    }
  }
  private readonly handleEnded = () => this.setState('ended')
  private readonly handleTimeUpdate = () => this.emit('time', this.currentTime)
  private readonly handleSeeked = () => this.emit('seeked', this.currentTime)
  private readonly handleVolumeChange = () => this.emit('volume', this.volume)
  private readonly handleRuntimeError = () => {
    if (this.currentState === 'loading' || this.currentState === 'idle' || this.disposed) return
    const error = mediaError(this.audio)
    this.setState('error')
    this.emit('error', error)
  }

  private async applyOutputDevice(): Promise<void> {
    if (typeof this.audio.setSinkId !== 'function') {
      if (this.outputDeviceId === 'default') return
      throw new Error('Audio output device selection is unavailable')
    }
    await this.audio.setSinkId(this.outputDeviceId)
  }

  private cancelPendingLoad(): void {
    this.loadController?.abort('Audio source changed')
    this.loadController = null
  }

  private resetElement(): void {
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  private releaseSource(): void {
    this.resetElement()
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
