import { invoke } from '@tauri-apps/api/core'
import { mapNativeTrack } from '@/features/catalog/infrastructure/native-catalog'
import type { AlbumCard } from '@/features/catalog/domain/catalog'
import { desktop } from '@/platform/desktop'
import {
  cancellableInvoke,
  integerField,
  isRecord,
  stringField,
  validHttpUrl,
  type InvokeCommand,
} from '@/platform/native-ipc'
import type { AlbumDetail, AlbumDisc } from '../domain/album'

function mapAlbumCard(value: unknown): AlbumCard | null {
  if (!isRecord(value) || value.kind !== 'album') return null
  const id = integerField(value, 'id', 1)
  const artistId = integerField(value, 'artistId', 1)
  const name = stringField(value, 'name')
  const artistName = stringField(value, 'artistName')
  const coverUrl = stringField(value, 'coverUrl')
  if (
    id === null ||
    artistId === null ||
    name.length === 0 ||
    artistName.length === 0 ||
    !validHttpUrl(coverUrl)
  ) {
    return null
  }
  return { kind: 'album', id, name, coverUrl, artistId, artistName }
}

function mapDisc(value: unknown, expectedAlbumId: number): AlbumDisc | null {
  if (!isRecord(value) || !Array.isArray(value.tracks)) return null
  const disc = stringField(value, 'disc')
  const tracks = value.tracks.map(mapNativeTrack)
  if (
    disc.length === 0 ||
    tracks.some((track) => track === null || track.album.id !== expectedAlbumId)
  ) {
    return null
  }
  return {
    disc,
    tracks: tracks.filter((track): track is NonNullable<typeof track> => track !== null),
  }
}

export function mapNativeAlbumDetail(value: unknown, expectedId: number): AlbumDetail {
  if (!isRecord(value) || !isRecord(value.artist) || !Array.isArray(value.discs)) {
    throw new Error('Invalid album detail response')
  }
  const id = integerField(value, 'id', 1)
  const publishTime = integerField(value, 'publishTime')
  const trackCount = integerField(value, 'trackCount')
  const durationMs = integerField(value, 'durationMs')
  const artistId = integerField(value.artist, 'id', 1)
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  const artistName = stringField(value.artist, 'name')
  if (
    id !== expectedId ||
    publishTime === null ||
    trackCount === null ||
    durationMs === null ||
    artistId === null ||
    name.length === 0 ||
    artistName.length === 0 ||
    !validHttpUrl(coverUrl) ||
    typeof value.description !== 'string' ||
    typeof value.company !== 'string' ||
    typeof value.albumType !== 'string' ||
    typeof value.explicit !== 'boolean' ||
    typeof value.subscribed !== 'boolean'
  ) {
    throw new Error('Invalid album detail response')
  }

  const discs = value.discs.map((disc) => mapDisc(disc, expectedId))
  if (discs.some((disc) => disc === null)) throw new Error('Invalid album disc response')
  const validDiscs = discs.filter((disc): disc is AlbumDisc => disc !== null)
  const discNames = validDiscs.map(({ disc }) => disc)
  const tracks = validDiscs.flatMap(({ tracks }) => tracks)
  const trackIds = tracks.map(({ id: trackId }) => trackId)
  if (
    new Set(discNames).size !== discNames.length ||
    new Set(trackIds).size !== trackIds.length ||
    tracks.length > trackCount ||
    tracks.reduce((sum, track) => sum + track.durationMs, 0) !== durationMs
  ) {
    throw new Error('Invalid album track metadata')
  }

  if (!Array.isArray(value.moreAlbums) || value.moreAlbums.length > 5) {
    throw new Error('Invalid related albums response')
  }
  const moreAlbums = value.moreAlbums.map(mapAlbumCard)
  if (
    moreAlbums.some(
      (album) => album === null || album.id === expectedId || album.artistId !== artistId,
    )
  ) {
    throw new Error('Invalid related albums response')
  }
  const validMoreAlbums = moreAlbums.filter((album): album is AlbumCard => album !== null)
  if (new Set(validMoreAlbums.map(({ id: albumId }) => albumId)).size !== validMoreAlbums.length) {
    throw new Error('Invalid related albums response')
  }

  return {
    id,
    name,
    coverUrl,
    artist: { id: artistId, name: artistName },
    publishTime,
    trackCount,
    durationMs,
    description: value.description,
    company: value.company,
    albumType: value.albumType,
    explicit: value.explicit,
    subscribed: value.subscribed,
    discs: validDiscs,
    moreAlbums: validMoreAlbums,
  }
}

export interface AlbumGateway {
  detail(albumId: number, signal?: AbortSignal): Promise<AlbumDetail>
  setSubscription(albumId: number, subscribed: boolean, signal?: AbortSignal): Promise<boolean>
}

export class NativeAlbumGateway implements AlbumGateway {
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

  async detail(albumId: number, signal?: AbortSignal): Promise<AlbumDetail> {
    const native = await this.cancellableInvoke<unknown>('album_detail', { albumId }, signal)
    return mapNativeAlbumDetail(native, albumId)
  }

  async setSubscription(
    albumId: number,
    subscribed: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const native = await this.cancellableInvoke<unknown>(
      'set_album_subscription',
      { albumId, subscribed },
      signal,
    )
    if (!isRecord(native) || native.subscribed !== subscribed) {
      throw new Error('Invalid album subscription response')
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
      desktopError: 'Album access requires the desktop app',
      abortMessage: 'Album request aborted',
      command,
      args,
      signal,
    })
  }
}
