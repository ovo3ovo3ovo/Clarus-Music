import { invoke } from '@tauri-apps/api/core'
import type { MusicVideoCard } from '@/features/catalog/domain/catalog'
import { desktop } from '@/platform/desktop'
import {
  cancellableInvoke,
  integerField,
  isRecord,
  stringField,
  validHttpUrl,
  type InvokeCommand,
} from '@/platform/native-ipc'
import type { MusicVideoDetail, MusicVideoSource } from '../domain/music-video'

const supportedResolutions = new Set([1080, 720, 480, 240])

function mapSource(value: unknown): MusicVideoSource | null {
  if (!isRecord(value)) return null
  const resolution = integerField(value, 'resolution')
  const sizeBytes = integerField(value, 'sizeBytes')
  const url = stringField(value, 'url')
  if (
    resolution === null ||
    !supportedResolutions.has(resolution) ||
    sizeBytes === null ||
    !validHttpUrl(url) ||
    value.mimeType !== 'video/mp4'
  ) {
    return null
  }
  return {
    resolution: resolution as MusicVideoSource['resolution'],
    url,
    mimeType: 'video/mp4',
    sizeBytes,
  }
}

function mapSimilarVideo(value: unknown): MusicVideoCard | null {
  if (!isRecord(value)) return null
  const id = integerField(value, 'id', 1)
  const artistId = integerField(value, 'artistId', 1)
  const durationMs = integerField(value, 'durationMs')
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  const artistName = stringField(value, 'artistName')
  if (
    id === null ||
    artistId === null ||
    durationMs === null ||
    name.length === 0 ||
    artistName.length === 0 ||
    !validHttpUrl(coverUrl)
  ) {
    return null
  }
  return { kind: 'musicVideo', id, name, coverUrl, artistId, artistName, durationMs }
}

function mapStrictArray<T>(
  value: unknown,
  minimum: number,
  maximum: number,
  mapper: (item: unknown) => T | null,
  error: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(error)
  }
  const mapped = value.map(mapper)
  if (mapped.some((item) => item === null)) throw new Error(error)
  return mapped.filter((item): item is T => item !== null)
}

export function mapNativeMusicVideoDetail(value: unknown, expectedId: number): MusicVideoDetail {
  if (!isRecord(value)) throw new Error('Invalid music video detail response')
  const id = integerField(value, 'id', 1)
  const artistId = integerField(value, 'artistId', 1)
  const playCount = integerField(value, 'playCount')
  const durationMs = integerField(value, 'durationMs')
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  const artistName = stringField(value, 'artistName')
  const publishTime = stringField(value, 'publishTime')
  if (
    id !== expectedId ||
    artistId === null ||
    playCount === null ||
    durationMs === null ||
    name.length === 0 ||
    artistName.length === 0 ||
    publishTime.length === 0 ||
    !validHttpUrl(coverUrl) ||
    typeof value.subscribed !== 'boolean'
  ) {
    throw new Error('Invalid music video detail response')
  }

  const sources = mapStrictArray(
    value.sources,
    1,
    4,
    mapSource,
    'Invalid music video sources response',
  )
  const resolutions = sources.map(({ resolution }) => resolution)
  if (
    new Set(resolutions).size !== resolutions.length ||
    resolutions.some((resolution, index) => index > 0 && resolutions[index - 1]! <= resolution)
  ) {
    throw new Error('Invalid music video sources response')
  }

  const similarVideos = mapStrictArray(
    value.similarVideos,
    0,
    12,
    mapSimilarVideo,
    'Invalid similar music videos response',
  )
  const similarIds = similarVideos.map(({ id }) => id)
  if (new Set(similarIds).size !== similarIds.length || similarIds.includes(expectedId)) {
    throw new Error('Invalid similar music videos response')
  }

  return {
    id,
    name,
    coverUrl,
    artistId,
    artistName,
    playCount,
    publishTime,
    durationMs,
    subscribed: value.subscribed,
    sources,
    similarVideos,
  }
}

export interface MusicVideoGateway {
  detail(videoId: number, signal?: AbortSignal): Promise<MusicVideoDetail>
  setSubscription(videoId: number, subscribed: boolean, signal?: AbortSignal): Promise<boolean>
}

export class NativeMusicVideoGateway implements MusicVideoGateway {
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

  async detail(videoId: number, signal?: AbortSignal): Promise<MusicVideoDetail> {
    const native = await this.cancellableInvoke<unknown>('music_video_detail', { videoId }, signal)
    return mapNativeMusicVideoDetail(native, videoId)
  }

  async setSubscription(
    videoId: number,
    subscribed: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const native = await this.cancellableInvoke<unknown>(
      'set_music_video_subscription',
      { videoId, subscribed },
      signal,
    )
    if (!isRecord(native) || native.subscribed !== subscribed) {
      throw new Error('Invalid music video subscription response')
    }
    return subscribed
  }

  private async cancellableInvoke<T>(
    command: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return cancellableInvoke<T>({
      invokeCommand: this.invokeCommand,
      createRequestId: this.createRequestId,
      isDesktop: this.isDesktop,
      desktopError: 'Music video access requires the desktop app',
      abortMessage: 'Music video request aborted',
      command,
      args,
      signal,
    })
  }
}
