import { invoke } from '@tauri-apps/api/core'
import { desktop } from '@/platform/desktop'
import {
  mapNativeAlbumCard,
  mapNativeArtistCard,
  mapNativeTrack,
} from '@/features/catalog/infrastructure/native-catalog'
import { mapNativePlaylistDetail } from '@/features/playlist/infrastructure/native-playlist'
import {
  cancellableInvoke,
  integerField,
  isRecord,
  stringField,
  validHttpUrl,
  type InvokeCommand,
  type UnknownRecord,
} from '@/platform/native-ipc'
import type {
  LibraryCatalogPage,
  LibraryCatalogSection,
  LibraryHistory,
  LibraryHistoryPeriod,
  LibraryOverview,
  LibraryPlaylist,
  LibraryPlaylistPage,
} from '../domain/library'

function assertUniqueIds(items: readonly { readonly id: number }[], context: string): void {
  if (new Set(items.map(({ id }) => id)).size !== items.length) {
    throw new Error(`The ${context} response contained duplicate items`)
  }
}

function mapPageMetadata(
  value: UnknownRecord,
  minimumOffset: number,
): { readonly nextOffset: number; readonly hasMore: boolean } {
  const nextOffset = integerField(value, 'nextOffset')
  if (
    nextOffset === null ||
    nextOffset < minimumOffset ||
    typeof value.hasMore !== 'boolean' ||
    (value.hasMore && nextOffset <= minimumOffset)
  ) {
    throw new Error('Invalid library page metadata')
  }
  return { nextOffset, hasMore: value.hasMore }
}

export function mapNativeLibraryPlaylist(value: unknown): LibraryPlaylist | null {
  if (!isRecord(value) || value.kind !== 'playlist') return null
  const id = integerField(value, 'id', 1)
  const creatorId = integerField(value, 'creatorId', 1)
  const trackCount = integerField(value, 'trackCount')
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  if (
    id === null ||
    creatorId === null ||
    trackCount === null ||
    name.length === 0 ||
    !validHttpUrl(coverUrl)
  ) {
    return null
  }
  return {
    kind: 'playlist',
    id,
    name,
    coverUrl,
    creatorId,
    creatorName: stringField(value, 'creatorName'),
    trackCount,
  }
}

export function mapNativeLibraryPlaylistPage(
  value: unknown,
  minimumOffset = 0,
): LibraryPlaylistPage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('Invalid library playlist page response')
  }
  const metadata = mapPageMetadata(value, minimumOffset)
  const items = value.items
    .map(mapNativeLibraryPlaylist)
    .filter((item): item is LibraryPlaylist => item !== null)
  if (value.items.length > 0 && items.length === 0) {
    throw new Error('The library playlist page contained no valid items')
  }
  assertUniqueIds(items, 'library playlist page')
  return { ...metadata, items }
}

export function mapNativeLibraryOverview(value: unknown, userId: number): LibraryOverview {
  if (!isRecord(value)) throw new Error('Invalid library overview response')
  const likedSongs = mapNativePlaylistDetail(value.likedSongs)
  const playlists = mapNativeLibraryPlaylistPage(value.playlists)
  if (
    likedSongs.creator.userId !== userId ||
    playlists.items[0]?.id !== likedSongs.id ||
    playlists.items[0]?.creatorId !== userId
  ) {
    throw new Error('The library overview belonged to an unexpected user')
  }
  return { likedSongs, playlists }
}

export function mapNativeLibraryCatalogPage(
  value: unknown,
  expectedSection: LibraryCatalogSection,
  minimumOffset = 0,
): LibraryCatalogPage {
  if (!isRecord(value) || value.section !== expectedSection || !Array.isArray(value.items)) {
    throw new Error('Invalid library catalog page response')
  }
  const metadata = mapPageMetadata(value, minimumOffset)
  if (expectedSection === 'albums') {
    const items = value.items
      .map(mapNativeAlbumCard)
      .filter((item): item is NonNullable<ReturnType<typeof mapNativeAlbumCard>> => item !== null)
    if (value.items.length > 0 && items.length === 0) {
      throw new Error('The library catalog page contained no valid items')
    }
    assertUniqueIds(items, 'library catalog page')
    return { ...metadata, section: expectedSection, items }
  }
  if (expectedSection === 'artists') {
    const items = value.items
      .map(mapNativeArtistCard)
      .filter((item): item is NonNullable<ReturnType<typeof mapNativeArtistCard>> => item !== null)
    if (value.items.length > 0 && items.length === 0) {
      throw new Error('The library catalog page contained no valid items')
    }
    assertUniqueIds(items, 'library catalog page')
    return { ...metadata, section: expectedSection, items }
  }
  throw new Error('Unsupported library catalog section')
}

export function mapNativeLibraryHistory(
  value: unknown,
  expectedPeriod: LibraryHistoryPeriod,
): LibraryHistory {
  if (!isRecord(value) || value.period !== expectedPeriod || !Array.isArray(value.items)) {
    throw new Error('Invalid library history response')
  }
  const items = value.items.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const track = mapNativeTrack(entry.track)
    const playCount = integerField(entry, 'playCount')
    return track && playCount !== null ? [{ track, playCount }] : []
  })
  if (value.items.length > 0 && items.length === 0) {
    throw new Error('The library history response contained no valid tracks')
  }
  assertUniqueIds(
    items.map(({ track }) => track),
    'library history',
  )
  return { period: expectedPeriod, items }
}

export interface LibraryGateway {
  overview(userId: number, signal?: AbortSignal): Promise<LibraryOverview>
  playlistPage(userId: number, offset: number, signal?: AbortSignal): Promise<LibraryPlaylistPage>
  catalogPage(
    section: LibraryCatalogSection,
    offset: number,
    signal?: AbortSignal,
  ): Promise<LibraryCatalogPage>
  history(
    userId: number,
    period: LibraryHistoryPeriod,
    signal?: AbortSignal,
  ): Promise<LibraryHistory>
  createPlaylist(
    name: string,
    privatePlaylist: boolean,
    signal?: AbortSignal,
  ): Promise<LibraryPlaylist>
}

export class NativeLibraryGateway implements LibraryGateway {
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

  async overview(userId: number, signal?: AbortSignal): Promise<LibraryOverview> {
    const native = await this.cancellableInvoke<unknown>('library_overview', { userId }, signal)
    return mapNativeLibraryOverview(native, userId)
  }

  async playlistPage(
    userId: number,
    offset: number,
    signal?: AbortSignal,
  ): Promise<LibraryPlaylistPage> {
    const native = await this.cancellableInvoke<unknown>(
      'library_playlist_page',
      { userId, offset },
      signal,
    )
    return mapNativeLibraryPlaylistPage(native, offset)
  }

  async catalogPage(
    section: LibraryCatalogSection,
    offset: number,
    signal?: AbortSignal,
  ): Promise<LibraryCatalogPage> {
    const native = await this.cancellableInvoke<unknown>(
      'library_catalog_page',
      { section, offset },
      signal,
    )
    return mapNativeLibraryCatalogPage(native, section, offset)
  }

  async history(
    userId: number,
    period: LibraryHistoryPeriod,
    signal?: AbortSignal,
  ): Promise<LibraryHistory> {
    const native = await this.cancellableInvoke<unknown>(
      'library_history',
      { userId, period },
      signal,
    )
    return mapNativeLibraryHistory(native, period)
  }

  async createPlaylist(
    name: string,
    privatePlaylist: boolean,
    signal?: AbortSignal,
  ): Promise<LibraryPlaylist> {
    const native = await this.cancellableInvoke<unknown>(
      'create_library_playlist',
      { name, private: privatePlaylist },
      signal,
    )
    const playlist = mapNativeLibraryPlaylist(native)
    if (!playlist) throw new Error('Invalid created playlist response')
    return playlist
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
      desktopError: 'Library access requires the desktop app',
      abortMessage: 'Library request aborted',
      command,
      args,
      signal,
    })
  }
}
