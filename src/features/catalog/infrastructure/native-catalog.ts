import { invoke } from '@tauri-apps/api/core'
import type { MusicQuality } from '@/features/settings/domain/settings'
import type { AudioSource } from '@/features/player/domain/audio-engine'
import {
  nativeAudioCacheGateway,
  type AudioCacheGateway,
  type CacheStoreRequest,
} from '@/features/cache/infrastructure/native-audio-cache'
import type { AlbumSummary, Artist, Track } from '@/types/music'
import { desktop } from '@/platform/desktop'
import {
  validatePerformanceAudioFixture,
  type PerformanceAudioFixture,
} from '@/performance/runtime-config'
import {
  cancellableInvoke,
  integerField as numberField,
  isRecord,
  stringField,
  validHttpUrl,
  type InvokeCommand,
  type UnknownRecord,
} from '@/platform/native-ipc'
import type {
  AlbumCard,
  ArtistCard,
  CatalogGateway,
  MusicVideoCard,
  PlaylistCard,
  SearchOverview,
  SearchResultPage,
  SearchSection,
  SearchType,
} from '../domain/catalog'

function stringArrayField(value: UnknownRecord, key: string): readonly string[] | null {
  const field = value[key]
  return Array.isArray(field) && field.every((item) => typeof item === 'string') ? field : null
}

function mapArtist(value: unknown): Artist | null {
  if (!isRecord(value)) return null
  const id = numberField(value, 'id', 1)
  const name = stringField(value, 'name')
  return id === null || name.length === 0 ? null : { id, name }
}

function mapAlbumSummary(value: unknown): AlbumSummary | null {
  if (!isRecord(value)) return null
  const id = numberField(value, 'id')
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  if (id === null || !validHttpUrl(coverUrl)) return null
  return { id, name, coverUrl }
}

export function mapNativeTrack(value: unknown): Track | null {
  if (!isRecord(value) || value.kind !== 'track') return null
  const id = numberField(value, 'id', 1)
  const durationMs = numberField(value, 'durationMs')
  const album = mapAlbumSummary(value.album)
  const name = stringField(value, 'name')
  if (
    id === null ||
    durationMs === null ||
    album === null ||
    name.length === 0 ||
    typeof value.explicit !== 'boolean' ||
    typeof value.playable !== 'boolean'
  ) {
    return null
  }
  const artists = Array.isArray(value.artists)
    ? value.artists.map(mapArtist).filter((artist): artist is Artist => artist !== null)
    : []
  const aliases = stringArrayField(value, 'aliases')
  const translatedNames = stringArrayField(value, 'translatedNames')
  if (aliases === null || translatedNames === null) return null
  return {
    id,
    name,
    durationMs,
    artists,
    album,
    aliases,
    translatedNames,
    explicit: value.explicit,
    playable: value.playable,
    unavailableReason: typeof value.unavailableReason === 'string' ? value.unavailableReason : null,
  }
}

export function mapNativeArtistCard(value: unknown): ArtistCard | null {
  if (!isRecord(value) || value.kind !== 'artist') return null
  const artist = mapArtist(value)
  const coverUrl = stringField(value, 'coverUrl')
  return artist === null || !validHttpUrl(coverUrl)
    ? null
    : { kind: 'artist', ...artist, coverUrl, description: stringField(value, 'description') }
}

export function mapNativeAlbumCard(value: unknown): AlbumCard | null {
  if (!isRecord(value) || value.kind !== 'album') return null
  const id = numberField(value, 'id', 1)
  const artistId = numberField(value, 'artistId', 1)
  const name = stringField(value, 'name')
  const artistName = stringField(value, 'artistName')
  const coverUrl = stringField(value, 'coverUrl')
  if (id === null || artistId === null || name.length === 0 || !validHttpUrl(coverUrl)) return null
  return { kind: 'album', id, name, coverUrl, artistId, artistName }
}

function mapPlaylistCard(value: unknown): PlaylistCard | null {
  if (!isRecord(value) || value.kind !== 'playlist') return null
  const id = numberField(value, 'id', 1)
  const trackCount = numberField(value, 'trackCount')
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  if (id === null || trackCount === null || name.length === 0 || !validHttpUrl(coverUrl))
    return null
  return {
    kind: 'playlist',
    id,
    name,
    coverUrl,
    creatorName: stringField(value, 'creatorName'),
    trackCount,
  }
}

export function mapNativeMusicVideoCard(value: unknown): MusicVideoCard | null {
  if (!isRecord(value) || value.kind !== 'musicVideo') return null
  const id = numberField(value, 'id', 1)
  const artistId = numberField(value, 'artistId')
  const durationMs = numberField(value, 'durationMs')
  const name = stringField(value, 'name')
  const coverUrl = stringField(value, 'coverUrl')
  if (
    id === null ||
    artistId === null ||
    durationMs === null ||
    name.length === 0 ||
    !validHttpUrl(coverUrl)
  ) {
    return null
  }
  return {
    kind: 'musicVideo',
    id,
    name,
    coverUrl,
    artistId,
    artistName: stringField(value, 'artistName'),
    durationMs,
  }
}

function mapSection<T>(
  root: UnknownRecord,
  key: string,
  mapper: (value: unknown) => T | null,
): SearchSection<T> {
  const native = root[key]
  if (!isRecord(native) || !Array.isArray(native.items)) {
    throw new Error(`Invalid search section: ${key}`)
  }
  const items = native.items.map(mapper).filter((item): item is T => item !== null)
  const total = numberField(native, 'total') ?? items.length
  const nativeError = native.error
  let error = isRecord(nativeError) ? stringField(nativeError, 'message') || null : null
  if (native.items.length > 0 && items.length === 0 && error === null) {
    error = 'The search response contained no valid items'
  }
  return { items, total: Math.max(total, items.length), error }
}

export function mapNativeSearchOverview(value: unknown): SearchOverview {
  if (!isRecord(value)) throw new Error('Invalid search overview response')
  return {
    tracks: mapSection(value, 'tracks', mapNativeTrack),
    artists: mapSection(value, 'artists', mapNativeArtistCard),
    albums: mapSection(value, 'albums', mapNativeAlbumCard),
    playlists: mapSection(value, 'playlists', mapPlaylistCard),
    musicVideos: mapSection(value, 'musicVideos', mapNativeMusicVideoCard),
  }
}

interface NativePageMetadata {
  readonly total: number
  readonly nextOffset: number
  readonly hasMore: boolean
}

function mapPageMetadata(root: UnknownRecord, minimumOffset: number): NativePageMetadata {
  const total = numberField(root, 'total')
  const nextOffset = numberField(root, 'nextOffset')
  if (
    total === null ||
    nextOffset === null ||
    nextOffset < minimumOffset ||
    total < nextOffset ||
    typeof root.hasMore !== 'boolean' ||
    (root.hasMore && nextOffset <= minimumOffset)
  ) {
    throw new Error('Invalid search page metadata')
  }
  return { total, nextOffset, hasMore: root.hasMore }
}

function mapPageItems<T>(
  items: readonly unknown[],
  mapper: (value: unknown) => T | null,
): readonly T[] {
  const mapped = items.map(mapper).filter((item): item is T => item !== null)
  if (items.length > 0 && mapped.length === 0) {
    throw new Error('The search page contained no valid items')
  }
  return mapped
}

export function mapNativeSearchPage(
  value: unknown,
  expectedType: SearchType,
  minimumOffset = 0,
): SearchResultPage {
  if (!isRecord(value) || value.searchType !== expectedType || !Array.isArray(value.items)) {
    throw new Error('Invalid search page response')
  }
  const metadata = mapPageMetadata(value, minimumOffset)
  switch (expectedType) {
    case 'tracks':
      return {
        ...metadata,
        searchType: expectedType,
        items: mapPageItems(value.items, mapNativeTrack),
      }
    case 'artists':
      return {
        ...metadata,
        searchType: expectedType,
        items: mapPageItems(value.items, mapNativeArtistCard),
      }
    case 'albums':
      return {
        ...metadata,
        searchType: expectedType,
        items: mapPageItems(value.items, mapNativeAlbumCard),
      }
    case 'playlists':
      return {
        ...metadata,
        searchType: expectedType,
        items: mapPageItems(value.items, mapPlaylistCard),
      }
    case 'musicVideos':
      return {
        ...metadata,
        searchType: expectedType,
        items: mapPageItems(value.items, mapNativeMusicVideoCard),
      }
  }
}

interface ResolvedRemoteStream {
  readonly source: AudioSource
  readonly cacheRequest: Omit<CacheStoreRequest, 'trackId' | 'quality'>
}

export type CatalogRuntimeConfig =
  | Readonly<{ mode: 'normal' }>
  | Readonly<{ mode: 'performance'; audioFixture: PerformanceAudioFixture }>

let catalogRuntimeConfig: CatalogRuntimeConfig = { mode: 'normal' }

/** Select the stream boundary before any mounted view creates a catalog gateway. */
export function configureCatalogRuntime(config: CatalogRuntimeConfig): void
export function configureCatalogRuntime(mode: 'normal'): void
export function configureCatalogRuntime(
  mode: 'performance',
  audioFixture: PerformanceAudioFixture,
): void
export function configureCatalogRuntime(
  configOrMode: CatalogRuntimeConfig | 'normal' | 'performance',
  audioFixture?: PerformanceAudioFixture,
): void {
  let config: CatalogRuntimeConfig
  if (typeof configOrMode === 'string') {
    if (configOrMode === 'normal') config = { mode: 'normal' }
    else {
      if (audioFixture === undefined) {
        throw new Error('Performance catalog runtime requires an audio fixture')
      }
      config = { mode: 'performance', audioFixture }
    }
  } else {
    config = configOrMode
  }
  catalogRuntimeConfig =
    config.mode === 'performance'
      ? { mode: 'performance', audioFixture: validatePerformanceAudioFixture(config.audioFixture) }
      : config
  nativeAudioCacheGateway.configureRuntime(config.mode)
}

// WKWebView's HTML media backend can report the requested currentTime after a
// FLAC seek while resuming the decoder from a different sample position.  The
// lyrics clock then looks correct numerically but no longer matches the audio
// being heard. Electron/Chromium (used by the reference app) does not exhibit
// the same behaviour. Keep remote playback on a seek-safe MP3 stream on macOS.
export function seekSafePlaybackQuality(quality: MusicQuality): MusicQuality {
  return quality === 'flac' || quality === '999000' ? '320000' : quality
}

function mapNativeStreamSource(value: unknown): ResolvedRemoteStream {
  if (!isRecord(value)) throw new Error('Invalid stream source response')
  const url = stringField(value, 'url')
  const mimeType = stringField(value, 'mimeType')
  const sizeBytes = numberField(value, 'sizeBytes')
  if (
    !validHttpUrl(url) ||
    !['audio/flac', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/mpeg'].includes(mimeType) ||
    sizeBytes === null
  ) {
    throw new Error('The stream source response is invalid')
  }
  return {
    source: { kind: 'remote', url },
    cacheRequest: { sourceUrl: url, mimeType, expectedSizeBytes: sizeBytes },
  }
}

export class NativeCatalogGateway implements CatalogGateway {
  private readonly invokeCommand: InvokeCommand
  private readonly createRequestId: () => string
  private readonly isDesktop: boolean
  private readonly audioCache: AudioCacheGateway
  private readonly explicitRuntimeConfig: CatalogRuntimeConfig | null

  constructor(
    invokeCommand: InvokeCommand = invoke,
    createRequestId: () => string = () => crypto.randomUUID(),
    isDesktop = desktop.isDesktop,
    audioCache: AudioCacheGateway = nativeAudioCacheGateway,
    runtimeConfig?: CatalogRuntimeConfig,
  ) {
    this.invokeCommand = invokeCommand
    this.createRequestId = createRequestId
    this.isDesktop = isDesktop
    this.audioCache = audioCache
    this.explicitRuntimeConfig = runtimeConfig ?? null
  }

  async searchOverview(keywords: string, signal?: AbortSignal): Promise<SearchOverview> {
    const native = await this.cancellableInvoke<unknown>('search_overview', { keywords }, signal)
    return mapNativeSearchOverview(native)
  }

  async searchPage(
    searchType: SearchType,
    keywords: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<SearchResultPage> {
    const native = await this.cancellableInvoke<unknown>(
      'search_catalog_page',
      { searchType, keywords, offset },
      signal,
    )
    return mapNativeSearchPage(native, searchType, offset)
  }

  async resolveStream(
    trackId: number,
    quality: MusicQuality,
    signal?: AbortSignal,
  ): Promise<AudioSource> {
    const runtimeConfig = this.explicitRuntimeConfig ?? catalogRuntimeConfig
    if (runtimeConfig.mode === 'performance') {
      const performanceAudioFixture = validatePerformanceAudioFixture(runtimeConfig.audioFixture)
      if (signal?.aborted) {
        throw new DOMException(
          String(signal.reason ?? 'Audio fixture request aborted'),
          'AbortError',
        )
      }
      // This direct loopback source deliberately bypasses both cache lookup
      // and cache preparation. HtmlAudioEngine keeps it on the browser's
      // native media path, where the fixture server can prove Range playback.
      return {
        kind: 'remote',
        url: performanceAudioFixture.url,
        provenance: 'performance-fixture',
      }
    }
    const playbackQuality = seekSafePlaybackQuality(quality)
    let cached: AudioSource | null = null
    try {
      cached = await this.audioCache.lookup(trackId, playbackQuality, signal)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
    }
    if (cached !== null) return cached
    const native = await this.cancellableInvoke<unknown>(
      'resolve_stream_url',
      { trackId, quality: playbackQuality },
      signal,
    )
    const resolved = mapNativeStreamSource(native)
    try {
      const prepared = await this.audioCache.prepare(
        {
          trackId,
          quality: playbackQuality,
          ...resolved.cacheRequest,
        },
        signal,
      )
      if (prepared !== null) return prepared
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
    }
    return resolved.source
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
      desktopError: 'Music catalog access requires the desktop app',
      abortMessage: 'Catalog request aborted',
      command,
      args,
      signal,
    })
  }
}
