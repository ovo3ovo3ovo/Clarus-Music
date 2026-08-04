import { invoke } from '@tauri-apps/api/core'
import { desktop } from '@/platform/desktop'
import { mapNativeTrack } from '@/features/catalog/infrastructure/native-catalog'
import {
  cancellableInvoke,
  integerField,
  isRecord,
  stringField,
  validHttpUrl,
  type InvokeCommand,
} from '@/platform/native-ipc'
import type { PlaylistDetail, PlaylistTrackPage } from '../domain/playlist'

function mapTracks(
  value: unknown,
  validIds: ReadonlySet<number>,
): readonly PlaylistDetail['tracks'][number][] {
  if (!Array.isArray(value)) throw new Error('Invalid playlist tracks response')
  const tracks = value
    .map(mapNativeTrack)
    .filter((track): track is NonNullable<ReturnType<typeof mapNativeTrack>> => track !== null)
  if (value.length > 0 && tracks.length === 0) {
    throw new Error('The playlist response contained no valid tracks')
  }
  if (
    tracks.some(({ id }) => !validIds.has(id)) ||
    new Set(tracks.map(({ id }) => id)).size !== tracks.length
  ) {
    throw new Error('The playlist response contained unexpected tracks')
  }
  return tracks
}

export function mapNativePlaylistDetail(value: unknown, expectedId?: number): PlaylistDetail {
  if (!isRecord(value)) throw new Error('Invalid playlist detail response')
  const id = integerField(value, 'id', 1)
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  const creator = value.creator
  const updateTime = integerField(value, 'updateTime')
  const trackCount = integerField(value, 'trackCount')
  const nextOffset = integerField(value, 'nextOffset')
  if (
    id === null ||
    (expectedId !== undefined && id !== expectedId) ||
    name.length === 0 ||
    !validHttpUrl(coverUrl) ||
    !isRecord(creator) ||
    updateTime === null ||
    trackCount === null ||
    nextOffset === null ||
    typeof value.description !== 'string' ||
    typeof value.private !== 'boolean' ||
    typeof value.subscribed !== 'boolean' ||
    typeof value.hasMore !== 'boolean' ||
    !Array.isArray(value.trackIds)
  ) {
    throw new Error('Invalid playlist detail response')
  }
  const creatorId = integerField(creator, 'userId')
  const creatorName = stringField(creator, 'name')
  const trackIds = value.trackIds.filter(
    (trackId): trackId is number =>
      typeof trackId === 'number' && Number.isSafeInteger(trackId) && trackId > 0,
  )
  if (
    creatorId === null ||
    trackIds.length !== value.trackIds.length ||
    new Set(trackIds).size !== trackIds.length ||
    trackCount < trackIds.length ||
    nextOffset > trackIds.length ||
    value.hasMore !== nextOffset < trackIds.length
  ) {
    throw new Error('Invalid playlist detail metadata')
  }
  const tracks = mapTracks(value.tracks, new Set(trackIds.slice(0, nextOffset)))
  return {
    id,
    name,
    coverUrl,
    creator: { userId: creatorId, name: creatorName },
    updateTime,
    trackCount,
    description: value.description,
    private: value.private,
    subscribed: value.subscribed,
    trackIds,
    tracks,
    nextOffset,
    hasMore: value.hasMore,
  }
}

export function mapNativePlaylistTrackPage(
  value: unknown,
  expectedTrackIds: readonly number[],
): PlaylistTrackPage {
  if (!isRecord(value)) throw new Error('Invalid playlist track page response')
  const requestedCount = integerField(value, 'requestedCount', 1)
  if (requestedCount !== expectedTrackIds.length) {
    throw new Error('Invalid playlist track page metadata')
  }
  return { tracks: mapTracks(value.tracks, new Set(expectedTrackIds)), requestedCount }
}

export interface PlaylistGateway {
  detail(playlistId: number, signal?: AbortSignal): Promise<PlaylistDetail>
  likedSongs(userId: number, signal?: AbortSignal): Promise<PlaylistDetail>
  trackPage(trackIds: readonly number[], signal?: AbortSignal): Promise<PlaylistTrackPage>
  setSubscription(playlistId: number, subscribed: boolean, signal?: AbortSignal): Promise<boolean>
  updateName(playlistId: number, name: string, signal?: AbortSignal): Promise<void>
  updateDescription(playlistId: number, description: string, signal?: AbortSignal): Promise<void>
  deletePlaylist(playlistId: number, signal?: AbortSignal): Promise<void>
  addTracks(playlistId: number, trackIds: readonly number[], signal?: AbortSignal): Promise<void>
  removeTracks(playlistId: number, trackIds: readonly number[], signal?: AbortSignal): Promise<void>
}

export class NativePlaylistGateway implements PlaylistGateway {
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

  async detail(playlistId: number, signal?: AbortSignal): Promise<PlaylistDetail> {
    const native = await this.cancellableInvoke<unknown>('playlist_detail', { playlistId }, signal)
    return mapNativePlaylistDetail(native, playlistId)
  }

  async likedSongs(userId: number, signal?: AbortSignal): Promise<PlaylistDetail> {
    const native = await this.cancellableInvoke<unknown>('liked_songs_detail', { userId }, signal)
    const detail = mapNativePlaylistDetail(native)
    if (detail.creator.userId !== userId) {
      throw new Error('The liked-songs playlist belonged to an unexpected user')
    }
    return detail
  }

  async trackPage(trackIds: readonly number[], signal?: AbortSignal): Promise<PlaylistTrackPage> {
    const native = await this.cancellableInvoke<unknown>(
      'playlist_track_page',
      { trackIds: [...trackIds] },
      signal,
    )
    return mapNativePlaylistTrackPage(native, trackIds)
  }

  async setSubscription(
    playlistId: number,
    subscribed: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const native = await this.cancellableInvoke<unknown>(
      'set_playlist_subscription',
      { playlistId, subscribed },
      signal,
    )
    if (!isRecord(native) || native.subscribed !== subscribed) {
      throw new Error('Invalid playlist subscription response')
    }
    return subscribed
  }

  async updateName(playlistId: number, name: string, signal?: AbortSignal): Promise<void> {
    await this.mutation('update_playlist_name', { playlistId, name }, signal)
  }

  async updateDescription(
    playlistId: number,
    description: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.mutation('update_playlist_description', { playlistId, description }, signal)
  }

  async deletePlaylist(playlistId: number, signal?: AbortSignal): Promise<void> {
    await this.mutation('delete_playlist', { playlistId }, signal)
  }

  async addTracks(
    playlistId: number,
    trackIds: readonly number[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.mutation('add_playlist_tracks', { playlistId, trackIds: [...trackIds] }, signal)
  }

  async removeTracks(
    playlistId: number,
    trackIds: readonly number[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.mutation('remove_playlist_tracks', { playlistId, trackIds: [...trackIds] }, signal)
  }

  private async mutation(
    command: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const native = await this.cancellableInvoke<unknown>(command, args, signal)
    if (!isRecord(native) || native.playlistId !== args.playlistId) {
      throw new Error('Invalid playlist mutation response')
    }
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
      desktopError: 'Playlist access requires the desktop app',
      abortMessage: 'Playlist request aborted',
      command,
      args,
      signal,
    })
  }
}
