export type AudioEngineState =
  'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error'

export type AudioSource =
  | Readonly<{ kind: 'remote'; url: string }>
  | Readonly<{ kind: 'managed-url'; url: string; mimeType: string; release: () => void }>
  | Readonly<{ kind: 'bytes'; bytes: ArrayBuffer; mimeType: string }>

export interface AudioEngineEventMap {
  state: AudioEngineState
  duration: number
  time: number
  seeked: number
  volume: number
  error: Error
}

export type AudioEngineListener<K extends keyof AudioEngineEventMap> = (
  value: AudioEngineEventMap[K],
) => void

export interface AudioEngine {
  readonly state: AudioEngineState
  readonly currentTime: number
  readonly duration: number
  readonly volume: number
  readonly supportsOutputDeviceSelection: boolean

  load(source: AudioSource, signal?: AbortSignal): Promise<void>
  play(): Promise<void>
  pause(): void
  seek(seconds: number): void
  setVolume(value: number): void
  setOutputDevice(deviceId: string): Promise<void>
  subscribe<K extends keyof AudioEngineEventMap>(
    event: K,
    listener: AudioEngineListener<K>,
  ): () => void
  dispose(): void
}
