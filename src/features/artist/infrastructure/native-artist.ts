import { invoke } from '@tauri-apps/api/core'
import { mapNativeTrack } from '@/features/catalog/infrastructure/native-catalog'
import { desktop } from '@/platform/desktop'
import {
  cancellableInvoke,
  integerField,
  isRecord,
  stringField,
  validHttpUrl,
  type InvokeCommand,
} from '@/platform/native-ipc'
import type {
  ArtistAlbum,
  ArtistDetail,
  ArtistIdentity,
  ArtistProfile,
  ArtistVideo,
  ArtistVideoPage,
} from '../domain/artist'

function mapIdentity(value: unknown, expectedId?: number): ArtistIdentity | null {
  if (!isRecord(value)) return null
  const id = integerField(value, 'id', 1)
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  if (
    id === null ||
    (expectedId !== undefined && id !== expectedId) ||
    name.length === 0 ||
    !validHttpUrl(coverUrl)
  ) {
    return null
  }
  return { id, name, coverUrl }
}

function mapProfile(value: unknown, expectedId: number): ArtistProfile | null {
  if (!isRecord(value)) return null
  const identity = mapIdentity(value, expectedId)
  const musicCount = integerField(value, 'musicCount')
  const albumCount = integerField(value, 'albumCount')
  const videoCount = integerField(value, 'videoCount')
  if (
    identity === null ||
    musicCount === null ||
    albumCount === null ||
    videoCount === null ||
    typeof value.briefDescription !== 'string' ||
    typeof value.followed !== 'boolean'
  ) {
    return null
  }
  return {
    ...identity,
    briefDescription: value.briefDescription,
    musicCount,
    albumCount,
    videoCount,
    followed: value.followed,
  }
}

function mapAlbum(value: unknown, expectedArtistId: number): ArtistAlbum | null {
  if (!isRecord(value)) return null
  const id = integerField(value, 'id', 1)
  const artistId = integerField(value, 'artistId', 1)
  const publishTime = integerField(value, 'publishTime')
  const trackCount = integerField(value, 'trackCount')
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  if (
    id === null ||
    artistId !== expectedArtistId ||
    publishTime === null ||
    trackCount === null ||
    name.length === 0 ||
    !validHttpUrl(coverUrl) ||
    typeof value.albumType !== 'string' ||
    typeof value.explicit !== 'boolean'
  ) {
    return null
  }
  return {
    id,
    artistId,
    name,
    coverUrl,
    publishTime,
    albumType: value.albumType,
    trackCount,
    explicit: value.explicit,
  }
}

function mapVideo(value: unknown, expectedArtistId: number): ArtistVideo | null {
  if (!isRecord(value)) return null
  const id = integerField(value, 'id', 1)
  const artistId = integerField(value, 'artistId', 1)
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  if (
    id === null ||
    artistId !== expectedArtistId ||
    name.length === 0 ||
    !validHttpUrl(coverUrl) ||
    typeof value.publishTime !== 'string'
  ) {
    return null
  }
  return { id, artistId, name, coverUrl, publishTime: value.publishTime }
}

function mapArray<T>(
  value: unknown,
  maximum: number,
  mapper: (item: unknown) => T | null,
  error: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(error)
  const mapped = value.map(mapper)
  if (mapped.some((item) => item === null)) throw new Error(error)
  return mapped.filter((item): item is T => item !== null)
}

function uniqueIds(items: readonly { readonly id: number }[], error: string): void {
  if (new Set(items.map(({ id }) => id)).size !== items.length) throw new Error(error)
}

export function mapNativeArtistDetail(value: unknown, expectedId: number): ArtistDetail {
  if (!isRecord(value)) throw new Error('Invalid artist detail response')
  const artist = mapProfile(value.artist, expectedId)
  if (artist === null) throw new Error('Invalid artist profile response')

  const popularTracks = mapArray(
    value.popularTracks,
    100,
    mapNativeTrack,
    'Invalid artist popular tracks response',
  )
  uniqueIds(popularTracks, 'Invalid artist popular tracks response')
  if (
    popularTracks.length > artist.musicCount ||
    popularTracks.some((track) => !track.artists.some(({ id }) => id === expectedId))
  ) {
    throw new Error('Invalid artist popular tracks response')
  }

  const albums = mapArray(
    value.albums,
    200,
    (album) => mapAlbum(album, expectedId),
    'Invalid artist albums response',
  )
  const eps = mapArray(
    value.eps,
    200,
    (album) => mapAlbum(album, expectedId),
    'Invalid artist albums response',
  )
  const allAlbums = [...albums, ...eps]
  uniqueIds(allAlbums, 'Invalid artist albums response')
  if (allAlbums.length > 200) throw new Error('Invalid artist albums response')

  const latestRelease =
    value.latestRelease === null ? null : mapAlbum(value.latestRelease, expectedId)
  if (value.latestRelease !== null && latestRelease === null) {
    throw new Error('Invalid artist latest release response')
  }
  if (latestRelease && !allAlbums.some(({ id }) => id === latestRelease.id)) {
    const latestType = latestRelease.albumType
    if (['专辑', '精选集', 'EP/Single', 'EP', 'Single'].includes(latestType)) {
      throw new Error('Invalid artist latest release response')
    }
  }

  const videos = mapArray(
    value.videos,
    30,
    (video) => mapVideo(video, expectedId),
    'Invalid artist videos response',
  )
  uniqueIds(videos, 'Invalid artist videos response')
  if (typeof value.videosHasMore !== 'boolean') throw new Error('Invalid artist videos response')

  const similarArtists = mapArray(
    value.similarArtists,
    12,
    (similar) => mapIdentity(similar),
    'Invalid similar artists response',
  )
  uniqueIds(similarArtists, 'Invalid similar artists response')
  if (similarArtists.some(({ id }) => id === expectedId)) {
    throw new Error('Invalid similar artists response')
  }

  return {
    artist,
    popularTracks,
    latestRelease,
    albums,
    eps,
    videos,
    videosHasMore: value.videosHasMore,
    similarArtists,
  }
}

export function mapNativeArtistHeader(value: unknown, expectedId: number): ArtistIdentity {
  const header = mapIdentity(value, expectedId)
  if (header === null) throw new Error('Invalid artist header response')
  return header
}

export function mapNativeArtistVideoPage(
  value: unknown,
  expectedArtistId: number,
  offset: number,
): ArtistVideoPage {
  if (!isRecord(value)) throw new Error('Invalid artist video page response')
  const nextOffset = integerField(value, 'nextOffset', offset)
  if (nextOffset === null || typeof value.hasMore !== 'boolean') {
    throw new Error('Invalid artist video page metadata')
  }
  const items = mapArray(
    value.items,
    100,
    (video) => mapVideo(video, expectedArtistId),
    'Invalid artist video page response',
  )
  uniqueIds(items, 'Invalid artist video page response')
  const rawProgress = nextOffset - offset
  if (rawProgress > 100 || items.length > rawProgress || (value.hasMore && rawProgress === 0)) {
    throw new Error('Invalid artist video page metadata')
  }
  return { items, nextOffset, hasMore: value.hasMore }
}

export interface ArtistGateway {
  detail(artistId: number, signal?: AbortSignal): Promise<ArtistDetail>
  header(artistId: number, signal?: AbortSignal): Promise<ArtistIdentity>
  videoPage(artistId: number, offset: number, signal?: AbortSignal): Promise<ArtistVideoPage>
  setSubscription(artistId: number, followed: boolean, signal?: AbortSignal): Promise<boolean>
}

export class NativeArtistGateway implements ArtistGateway {
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

  async detail(artistId: number, signal?: AbortSignal): Promise<ArtistDetail> {
    const native = await this.cancellableInvoke<unknown>('artist_detail', { artistId }, signal)
    return mapNativeArtistDetail(native, artistId)
  }

  async header(artistId: number, signal?: AbortSignal): Promise<ArtistIdentity> {
    const native = await this.cancellableInvoke<unknown>('artist_header', { artistId }, signal)
    return mapNativeArtistHeader(native, artistId)
  }

  async videoPage(
    artistId: number,
    offset: number,
    signal?: AbortSignal,
  ): Promise<ArtistVideoPage> {
    const native = await this.cancellableInvoke<unknown>(
      'artist_video_page',
      { artistId, offset },
      signal,
    )
    return mapNativeArtistVideoPage(native, artistId, offset)
  }

  async setSubscription(
    artistId: number,
    followed: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const native = await this.cancellableInvoke<unknown>(
      'set_artist_subscription',
      { artistId, followed },
      signal,
    )
    if (!isRecord(native) || native.followed !== followed) {
      throw new Error('Invalid artist subscription response')
    }
    return followed
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
      desktopError: 'Artist access requires the desktop app',
      abortMessage: 'Artist request aborted',
      command,
      args,
      signal,
    })
  }
}
