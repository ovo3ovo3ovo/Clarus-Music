import type { RepeatMode, Track } from '@/types/music'

export const PLAYER_QUEUE_SNAPSHOT_VERSION = 1
export const MAX_PERSISTED_QUEUE_TRACKS = 1_000
export const MAX_PERSISTED_PLAY_NEXT_TRACKS = 100
const MAX_TEXT_LENGTH = 1_024
const MAX_ARTISTS = 20

export interface PlayerQueueSnapshot {
  readonly version: 1
  readonly queue: readonly Track[]
  readonly playNextQueue: readonly Track[]
  readonly currentTrack: Track | null
  readonly currentIndex: number
  readonly currentIsPlayNext: boolean
  readonly queueSource: string | null
  readonly playbackOrder: readonly number[]
  readonly repeatMode: RepeatMode
  readonly shuffle: boolean
  readonly reversed: boolean
  readonly volume: number
  readonly progress: number
}

export interface PlayerQueuePersistence {
  load(): PlayerQueueSnapshot | null
  save(snapshot: PlayerQueueSnapshot): void
  clear(): void
}

const SPLIT_STORAGE_VERSION = 1
const SPLIT_QUEUE_SUFFIX = '.queue'
const SPLIT_STATE_SUFFIX = '.state'

interface QueueStructureRecord {
  readonly storageVersion: 1
  readonly revision: number
  readonly queue: readonly Track[]
  readonly playNextQueue: readonly Track[]
  readonly playbackOrder: readonly number[]
  readonly queueSource: string | null
}

interface PlaybackStateRecord {
  readonly storageVersion: 1
  readonly revision: number
  readonly currentTrack: Track | null
  readonly currentIndex: number
  readonly currentIsPlayNext: boolean
  readonly repeatMode: RepeatMode
  readonly shuffle: boolean
  readonly reversed: boolean
  readonly volume: number
  readonly progress: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseTrack(value: unknown): Track | null {
  if (!isRecord(value) || !positiveInteger(value.id) || !safeText(value.name)) return null
  if (!nonNegativeInteger(value.durationMs) || value.durationMs > 24 * 60 * 60 * 1_000) return null
  if (!Array.isArray(value.artists) || value.artists.length > MAX_ARTISTS) return null
  const artists = value.artists.map((artist) => {
    if (!isRecord(artist) || !positiveInteger(artist.id) || !safeText(artist.name)) return null
    return { id: artist.id, name: artist.name }
  })
  if (artists.some((artist) => artist === null)) return null
  if (!isRecord(value.album) || !nonNegativeInteger(value.album.id)) return null
  if (!safeText(value.album.name) || !safeText(value.album.coverUrl)) return null
  if (
    !Array.isArray(value.aliases) ||
    value.aliases.length > 20 ||
    !value.aliases.every(safeText)
  ) {
    return null
  }
  const translatedNames = value.translatedNames ?? []
  if (
    !Array.isArray(translatedNames) ||
    translatedNames.length > 20 ||
    !translatedNames.every(safeText)
  ) {
    return null
  }
  if (typeof value.explicit !== 'boolean' || typeof value.playable !== 'boolean') return null
  if (value.unavailableReason !== null && !safeText(value.unavailableReason)) return null
  return {
    id: value.id,
    name: value.name,
    durationMs: value.durationMs,
    artists: artists as readonly { readonly id: number; readonly name: string }[],
    album: { id: value.album.id, name: value.album.name, coverUrl: value.album.coverUrl },
    aliases: [...value.aliases],
    translatedNames: [...translatedNames],
    explicit: value.explicit,
    playable: value.playable,
    unavailableReason: value.unavailableReason,
  }
}

function parseTracks(value: unknown, limit: number, unique: boolean): readonly Track[] | null {
  if (!Array.isArray(value) || value.length > limit) return null
  const tracks = value.map(parseTrack)
  if (tracks.some((track) => track === null)) return null
  const validTracks = tracks as readonly Track[]
  if (unique && new Set(validTracks.map(({ id }) => id)).size !== validTracks.length) return null
  return validTracks
}

function parsePlaybackOrder(value: unknown, queueLength: number, shuffle: boolean) {
  if (!Array.isArray(value) || !value.every(nonNegativeInteger)) return null
  if (!shuffle) return value.length === 0 ? [] : null
  if (value.length !== queueLength || new Set(value).size !== queueLength) return null
  return value.every((index) => index < queueLength) ? [...value] : null
}

export function parsePlayerQueueSnapshot(value: unknown): PlayerQueueSnapshot | null {
  if (!isRecord(value) || value.version !== PLAYER_QUEUE_SNAPSHOT_VERSION) return null
  const queue = parseTracks(value.queue, MAX_PERSISTED_QUEUE_TRACKS, true)
  const playNextQueue = parseTracks(value.playNextQueue, MAX_PERSISTED_PLAY_NEXT_TRACKS, false)
  if (!queue || !playNextQueue) return null
  if (value.repeatMode !== 'off' && value.repeatMode !== 'all' && value.repeatMode !== 'one') {
    return null
  }
  if (typeof value.shuffle !== 'boolean' || typeof value.reversed !== 'boolean') return null
  if (typeof value.currentIsPlayNext !== 'boolean') return null
  if (
    typeof value.currentIndex !== 'number' ||
    !Number.isSafeInteger(value.currentIndex) ||
    value.currentIndex < (queue.length === 0 ? -1 : 0) ||
    value.currentIndex >= queue.length
  ) {
    return null
  }
  if (
    value.queueSource !== null &&
    (!safeText(value.queueSource) || value.queueSource.length > 256)
  ) {
    return null
  }
  const currentTrack = value.currentTrack === null ? null : parseTrack(value.currentTrack)
  if (value.currentTrack !== null && currentTrack === null) return null
  if (
    currentTrack &&
    !value.currentIsPlayNext &&
    queue[value.currentIndex]?.id !== currentTrack.id
  ) {
    return null
  }
  const playbackOrder = parsePlaybackOrder(value.playbackOrder, queue.length, value.shuffle)
  if (!playbackOrder) return null
  if (typeof value.volume !== 'number' || !Number.isFinite(value.volume)) return null
  if (value.volume < 0 || value.volume > 1) return null
  if (
    typeof value.progress !== 'number' ||
    !Number.isFinite(value.progress) ||
    value.progress < 0
  ) {
    return null
  }
  return {
    version: PLAYER_QUEUE_SNAPSHOT_VERSION,
    queue,
    playNextQueue,
    currentTrack,
    currentIndex: value.currentIndex,
    currentIsPlayNext: value.currentIsPlayNext,
    queueSource: value.queueSource,
    playbackOrder,
    repeatMode: value.repeatMode,
    shuffle: value.shuffle,
    reversed: value.reversed,
    volume: value.volume,
    progress: currentTrack
      ? Math.min(value.progress, Math.max(0, currentTrack.durationMs / 1_000))
      : 0,
  }
}

export function createLocalPlayerQueuePersistence(
  storage: Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key = 'clarus-music.player.queue.v1',
): PlayerQueuePersistence {
  const queueKey = `${key}${SPLIT_QUEUE_SUFFIX}`
  const stateKey = `${key}${SPLIT_STATE_SUFFIX}`
  let revision = 0
  let markerRevision: number | null = null
  let lastStructure:
    | {
        readonly queue: readonly Track[]
        readonly playNextQueue: readonly Track[]
        readonly playbackOrder: readonly number[]
        readonly queueSource: string | null
      }
    | undefined

  const clearStoredRecords = (): void => {
    for (const storageKey of [key, queueKey, stateKey]) {
      try {
        storage.removeItem(storageKey)
      } catch {
        // Storage can be disabled by WebView policy.
      }
    }
    revision = 0
    markerRevision = null
    lastStructure = undefined
  }

  return {
    load() {
      try {
        const raw = storage.getItem(key)
        if (raw === null) return null
        const parsed = JSON.parse(raw) as UnknownRecord
        let snapshot: PlayerQueueSnapshot | null
        if (
          parsed.storageVersion === SPLIT_STORAGE_VERSION &&
          parsed.storage === 'split' &&
          Number.isSafeInteger(parsed.revision) &&
          parsed.revision > 0
        ) {
          const queueRecord = JSON.parse(
            storage.getItem(queueKey) ?? 'null',
          ) as QueueStructureRecord
          const stateRecord = JSON.parse(storage.getItem(stateKey) ?? 'null') as PlaybackStateRecord
          if (
            queueRecord?.storageVersion !== SPLIT_STORAGE_VERSION ||
            stateRecord?.storageVersion !== SPLIT_STORAGE_VERSION ||
            queueRecord.revision !== parsed.revision ||
            stateRecord.revision !== parsed.revision
          ) {
            snapshot = null
          } else {
            snapshot = parsePlayerQueueSnapshot({
              version: PLAYER_QUEUE_SNAPSHOT_VERSION,
              queue: queueRecord.queue,
              playNextQueue: queueRecord.playNextQueue,
              currentTrack: stateRecord.currentTrack,
              currentIndex: stateRecord.currentIndex,
              currentIsPlayNext: stateRecord.currentIsPlayNext,
              queueSource: queueRecord.queueSource,
              playbackOrder: queueRecord.playbackOrder,
              repeatMode: stateRecord.repeatMode,
              shuffle: stateRecord.shuffle,
              reversed: stateRecord.reversed,
              volume: stateRecord.volume,
              progress: stateRecord.progress,
            })
          }
        } else {
          snapshot = parsePlayerQueueSnapshot(parsed)
        }
        if (snapshot === null) {
          clearStoredRecords()
        }
        return snapshot
      } catch {
        clearStoredRecords()
        return null
      }
    },
    save(snapshot) {
      const previousValues = new Map(
        [key, queueKey, stateKey].map((storageKey) => [storageKey, storage.getItem(storageKey)]),
      )
      const previousRevision = revision
      const previousMarkerRevision = markerRevision
      const previousStructure = lastStructure
      try {
        const structureChanged =
          lastStructure === undefined ||
          lastStructure.queue !== snapshot.queue ||
          lastStructure.playNextQueue !== snapshot.playNextQueue ||
          lastStructure.playbackOrder !== snapshot.playbackOrder ||
          lastStructure.queueSource !== snapshot.queueSource
        if (structureChanged) {
          revision = Math.max(1, revision + 1)
          const queueRecord: QueueStructureRecord = {
            storageVersion: SPLIT_STORAGE_VERSION,
            revision,
            queue: snapshot.queue,
            playNextQueue: snapshot.playNextQueue,
            playbackOrder: snapshot.playbackOrder,
            queueSource: snapshot.queueSource,
          }
          storage.setItem(queueKey, JSON.stringify(queueRecord))
          lastStructure = {
            queue: snapshot.queue,
            playNextQueue: snapshot.playNextQueue,
            playbackOrder: snapshot.playbackOrder,
            queueSource: snapshot.queueSource,
          }
        }

        const stateRecord: PlaybackStateRecord = {
          storageVersion: SPLIT_STORAGE_VERSION,
          revision,
          currentTrack: snapshot.currentTrack,
          currentIndex: snapshot.currentIndex,
          currentIsPlayNext: snapshot.currentIsPlayNext,
          repeatMode: snapshot.repeatMode,
          shuffle: snapshot.shuffle,
          reversed: snapshot.reversed,
          volume: snapshot.volume,
          progress: snapshot.progress,
        }
        storage.setItem(stateKey, JSON.stringify(stateRecord))
        if (markerRevision !== revision) {
          storage.setItem(
            key,
            JSON.stringify({
              storageVersion: SPLIT_STORAGE_VERSION,
              storage: 'split',
              revision,
            }),
          )
          markerRevision = revision
        }
      } catch (error) {
        revision = previousRevision
        markerRevision = previousMarkerRevision
        lastStructure = previousStructure
        for (const [storageKey, value] of previousValues) {
          try {
            if (value === null) storage.removeItem(storageKey)
            else storage.setItem(storageKey, value)
          } catch {
            // Preserve the original storage error; recovery is best effort.
          }
        }
        throw error
      }
    },
    clear() {
      clearStoredRecords()
    },
  }
}

export const noPlayerQueuePersistence: PlayerQueuePersistence = {
  load: () => null,
  save: () => undefined,
  clear: () => undefined,
}
