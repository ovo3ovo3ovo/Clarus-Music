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

type ActiveSource = Readonly<{
  generation: number
  expectedUrl: string
}>

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
  private loadGeneration = 0
  private activeSource: ActiveSource | null = null
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
    const generation = this.nextLoadGeneration()
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
    // Read back the DOM-normalized URL. `currentSrc` uses the same form, so
    // later media events can prove that they belong to this load rather than
    // to a native event still draining from a superseded source.
    const expectedUrl = this.audio.src
    this.activeSource = { generation, expectedUrl }

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.audio.removeEventListener('loadedmetadata', handleMetadata)
          this.audio.removeEventListener('error', handleError)
          controller.signal.removeEventListener('abort', handleAbort)
        }
        const handleMetadata = () => {
          // Do not clean up on a stale event: these listeners now belong to
          // the current request and must remain armed for its real metadata.
          if (!this.isCurrentLoad(controller, generation, expectedUrl)) return
          cleanup()
          this.setState('ready')
          this.emit('duration', this.duration)
          void this.applyOutputDevice().catch((reason: unknown) => {
            if (!this.isCurrentSource(generation, expectedUrl)) return
            const error = reason instanceof Error ? reason : new Error(String(reason))
            this.emit('error', error)
          })
          resolve()
        }
        const handleError = () => {
          if (!this.isCurrentLoad(controller, generation, expectedUrl)) return
          cleanup()
          const error = mediaError(this.audio)
          this.setState('error')
          reject(error)
        }
        const handleAbort = () => {
          cleanup()
          if (this.ownsLoad(controller, generation)) this.resetElement()
          reject(abortError(controller.signal.reason))
        }
        // These deliberately are not `{ once: true }`: a stale native event
        // would consume a once-listener before its guard can reject it.
        this.audio.addEventListener('loadedmetadata', handleMetadata)
        this.audio.addEventListener('error', handleError)
        controller.signal.addEventListener('abort', handleAbort, { once: true })
        this.audio.load()
      })
    } catch (error) {
      if (this.ownsLoad(controller, generation)) this.releaseSource()
      throw error
    } finally {
      signal?.removeEventListener('abort', forwardAbort)
      if (this.ownsLoad(controller, generation)) this.loadController = null
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
    this.nextLoadGeneration()
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

  private readonly handlePlay = () => {
    if (this.hasCurrentSource()) this.setState('playing')
  }
  private readonly handlePause = () => {
    if (
      !this.disposed &&
      this.hasCurrentSource() &&
      this.currentState !== 'loading' &&
      this.currentState !== 'idle'
    ) {
      this.setState('paused')
    }
  }
  private readonly handleEnded = () => {
    if (this.hasCurrentSource()) this.setState('ended')
  }
  private readonly handleTimeUpdate = () => {
    if (this.hasCurrentSource()) this.emit('time', this.currentTime)
  }
  private readonly handleSeeked = () => {
    if (this.hasCurrentSource()) this.emit('seeked', this.currentTime)
  }
  private readonly handleVolumeChange = () => this.emit('volume', this.volume)
  private readonly handleRuntimeError = () => {
    if (
      this.currentState === 'loading' ||
      this.currentState === 'idle' ||
      this.disposed ||
      !this.hasCurrentSource()
    ) {
      return
    }
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
    this.activeSource = null
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

  private nextLoadGeneration(): number {
    this.loadGeneration += 1
    return this.loadGeneration
  }

  private ownsLoad(controller: AbortController, generation: number): boolean {
    return (
      this.loadController === controller && this.activeSource?.generation === generation
    )
  }

  private isCurrentLoad(
    controller: AbortController,
    generation: number,
    expectedUrl: string,
  ): boolean {
    return (
      !controller.signal.aborted &&
      this.ownsLoad(controller, generation) &&
      this.isCurrentSource(generation, expectedUrl)
    )
  }

  private hasCurrentSource(): boolean {
    const source = this.activeSource
    return source !== null && this.isCurrentSource(source.generation, source.expectedUrl)
  }

  private isCurrentSource(generation: number, expectedUrl: string): boolean {
    // Real media elements always expose `currentSrc`; the narrow fallback
    // keeps lightweight non-DOM test doubles compatible without weakening the
    // browser path, where an empty `currentSrc` deliberately never matches.
    const currentSrc = this.audio.currentSrc
    const matchesSource =
      typeof currentSrc === 'string'
        ? currentSrc === expectedUrl
        : this.audio.src === expectedUrl
    return (
      !this.disposed &&
      this.activeSource?.generation === generation &&
      this.activeSource.expectedUrl === expectedUrl &&
      matchesSource
    )
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
