import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { AudioSource } from '@/features/player/domain/audio-engine'
import type { MusicQuality } from '@/features/settings/domain/settings'
import { desktop } from '@/platform/desktop'
import type { AudioCacheStats } from '../domain/audio-cache'

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
type ConvertFileSrc = (filePath: string) => string
type UnknownRecord = Record<string, unknown>

export interface CacheStoreRequest {
  readonly trackId: number
  readonly quality: MusicQuality
  readonly sourceUrl: string
  readonly mimeType: string
  readonly expectedSizeBytes: number
}

export interface AudioCacheGateway {
  lookup(trackId: number, quality: MusicQuality, signal?: AbortSignal): Promise<AudioSource | null>
  prepare(request: CacheStoreRequest, signal?: AbortSignal): Promise<AudioSource | null>
  stats(): Promise<AudioCacheStats>
  clear(): Promise<AudioCacheStats>
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedInteger(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function abortError(reason?: unknown): DOMException {
  return new DOMException(String(reason ?? 'Audio cache request aborted'), 'AbortError')
}

function validMimeType(value: string): boolean {
  return ['audio/flac', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/mpeg'].includes(value)
}

export function mapNativeCacheStats(value: unknown): AudioCacheStats {
  if (!isRecord(value)) throw new Error('Invalid audio cache statistics')
  const trackCount = boundedInteger(value.entryCount)
  const totalBytes = boundedInteger(value.totalBytes)
  const leasedEntries = boundedInteger(value.leasedEntries)
  const limitBytes = boundedInteger(value.limitBytes, 128 * 1024 * 1024)
  if (
    trackCount === null ||
    totalBytes === null ||
    leasedEntries === null ||
    leasedEntries > trackCount ||
    limitBytes === null ||
    (totalBytes > limitBytes && leasedEntries === 0)
  ) {
    throw new Error('Invalid audio cache statistics')
  }
  return { trackCount, totalBytes, limitBytes }
}

interface NativeCachedAudioSource {
  readonly filePath: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly leaseId: string
}

function mapNativeCachedSource(value: unknown): NativeCachedAudioSource {
  if (!isRecord(value)) throw new Error('Invalid cached audio source')
  const filePath = boundedString(value.filePath, 4096)
  const mimeType = boundedString(value.mimeType, 64)
  const sizeBytes = boundedInteger(value.sizeBytes, 1)
  const leaseId = boundedString(value.leaseId, 128)
  if (
    filePath === null ||
    mimeType === null ||
    !validMimeType(mimeType) ||
    sizeBytes === null ||
    leaseId === null ||
    !/^[\x20-\x7e]+$/.test(leaseId)
  ) {
    throw new Error('Invalid cached audio source')
  }
  return { filePath, mimeType, sizeBytes, leaseId }
}

export class NativeAudioCacheGateway implements AudioCacheGateway {
  private readonly invokeCommand: InvokeCommand
  private readonly isDesktop: boolean
  private readonly createRequestId: () => string
  private readonly createManagedUrl: ConvertFileSrc
  private automaticCachingEnabled = true
  private storeController: AbortController | null = null

  constructor(
    invokeCommand: InvokeCommand = invoke,
    isDesktop = desktop.isDesktop,
    createRequestId: () => string = () => crypto.randomUUID(),
    createManagedUrl: ConvertFileSrc = convertFileSrc,
  ) {
    this.invokeCommand = invokeCommand
    this.isDesktop = isDesktop
    this.createRequestId = createRequestId
    this.createManagedUrl = createManagedUrl
  }

  configure(automaticCachingEnabled: boolean): void {
    this.automaticCachingEnabled = automaticCachingEnabled
    if (!automaticCachingEnabled) this.storeController?.abort('Automatic audio caching disabled')
  }

  async lookup(
    trackId: number,
    quality: MusicQuality,
    signal?: AbortSignal,
  ): Promise<AudioSource | null> {
    if (!this.isDesktop) return null
    if (signal?.aborted) throw abortError(signal.reason)
    const value = await this.invokeCommand<unknown>('lookup_audio_cache', { trackId, quality })
    if (value === null) return null

    let native: NativeCachedAudioSource
    try {
      native = mapNativeCachedSource(value)
    } catch (error) {
      const leaseId = isRecord(value) ? boundedString(value.leaseId, 128) : null
      if (leaseId !== null) void this.releaseLease(leaseId)
      throw error
    }
    if (signal?.aborted) {
      void this.releaseLease(native.leaseId)
      throw abortError(signal.reason)
    }

    const release = this.createLeaseRelease(native.leaseId)
    try {
      const url = this.createManagedUrl(native.filePath)
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('Cached audio asset URL was empty')
      }

      if (signal?.aborted) {
        release()
        throw abortError(signal.reason)
      }
      return {
        kind: 'managed-url',
        url,
        mimeType: native.mimeType,
        release,
      }
    } catch (error) {
      if (signal?.aborted) {
        release()
        throw abortError(signal.reason)
      }
      try {
        const bytes = await this.readCachedBytes(native, signal)
        release()
        return {
          kind: 'bytes',
          bytes,
          mimeType: native.mimeType,
        }
      } catch (fallbackError) {
        release()
        if (signal?.aborted) throw abortError(signal.reason)
        throw fallbackError ?? error
      }
    }
  }

  async prepare(request: CacheStoreRequest, signal?: AbortSignal): Promise<AudioSource | null> {
    if (!this.isDesktop || !this.automaticCachingEnabled) return null
    this.storeController?.abort('Audio cache source changed')
    const controller = new AbortController()
    this.storeController = controller
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) forwardAbort()
    try {
      await this.cancellableStore(request, controller.signal)
      return await this.lookup(request.trackId, request.quality, controller.signal)
    } finally {
      signal?.removeEventListener('abort', forwardAbort)
      if (this.storeController === controller) this.storeController = null
    }
  }

  async stats(): Promise<AudioCacheStats> {
    if (!this.isDesktop) return { trackCount: 0, totalBytes: 0, limitBytes: null }
    return mapNativeCacheStats(await this.invokeCommand<unknown>('audio_cache_stats'))
  }

  async clear(): Promise<AudioCacheStats> {
    if (!this.isDesktop) return { trackCount: 0, totalBytes: 0, limitBytes: null }
    this.storeController?.abort('Audio cache cleared')
    await this.invokeCommand<unknown>('clear_audio_cache')
    return this.stats()
  }

  private async cancellableStore(request: CacheStoreRequest, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError(signal.reason)
    const requestId = this.createRequestId()
    const cancel = () => {
      void this.invokeCommand<boolean>('cancel_music_request', { requestId }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await this.invokeCommand('store_audio_cache', { ...request, requestId })
      if (signal.aborted) throw abortError(signal.reason)
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason)
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  private releaseLease(leaseId: string): Promise<boolean> {
    return this.invokeCommand<boolean>('release_audio_cache_lease', { leaseId }).catch(() => false)
  }

  private createLeaseRelease(leaseId: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      void this.releaseLease(leaseId)
    }
  }

  private async readCachedBytes(
    native: NativeCachedAudioSource,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const bytes = await this.invokeCommand<ArrayBuffer>('read_audio_cache_bytes', {
      leaseId: native.leaseId,
    })
    if (signal?.aborted) throw abortError(signal.reason)
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== native.sizeBytes) {
      throw new Error('Cached audio bytes did not match their index')
    }
    return bytes
  }
}

export const nativeAudioCacheGateway = new NativeAudioCacheGateway()
