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
  const versionedKey = (base: string, revision: number): string => `${base}.${revision}`
  let queueRevision = 0
  let stateRevision = 0
  let obsoleteQueueRevision = 0
  let obsoleteStateRevision = 0
  let lastStructure:
    | {
        readonly queue: readonly Track[]
        readonly playNextQueue: readonly Track[]
        readonly playbackOrder: readonly number[]
        readonly queueSource: string | null
      }
    | undefined

  const clearStoredRecords = (propagateErrors = false): void => {
    let firstError: unknown = null
    const storageKeys = new Set([key, queueKey, stateKey])
    for (const revision of [queueRevision, obsoleteQueueRevision]) {
      if (revision > 0) storageKeys.add(versionedKey(queueKey, revision))
    }
    for (const revision of [stateRevision, obsoleteStateRevision]) {
      if (revision > 0) storageKeys.add(versionedKey(stateKey, revision))
    }
    for (const storageKey of storageKeys) {
      try {
        storage.removeItem(storageKey)
      } catch (error) {
        if (firstError === null) firstError = error
        // Storage can be disabled by WebView policy.
      }
    }
    queueRevision = 0
    stateRevision = 0
    obsoleteQueueRevision = 0
    obsoleteStateRevision = 0
    lastStructure = undefined
    if (propagateErrors && firstError !== null) throw firstError
  }

  const removeObsoleteRecords = (): void => {
    const storageKeys = new Set<string>([queueKey, stateKey])
    if (obsoleteQueueRevision > 0) {
      storageKeys.add(versionedKey(queueKey, obsoleteQueueRevision))
    }
    if (obsoleteStateRevision > 0) {
      storageKeys.add(versionedKey(stateKey, obsoleteStateRevision))
    }
    for (const storageKey of storageKeys) {
      try {
        storage.removeItem(storageKey)
      } catch {
        // The new marker is already durable; stale records are harmless.
      }
    }
    obsoleteQueueRevision = 0
    obsoleteStateRevision = 0
  }

  const readVersionedSnapshot = (
    queueRevisionToRead: number,
    stateRevisionToRead: number,
  ): PlayerQueueSnapshot | null => {
    if (queueRevisionToRead <= 0 || stateRevisionToRead <= 0) return null
    try {
      const queueRecord = JSON.parse(
        storage.getItem(versionedKey(queueKey, queueRevisionToRead)) ?? 'null',
      ) as QueueStructureRecord
      const stateRecord = JSON.parse(
        storage.getItem(versionedKey(stateKey, stateRevisionToRead)) ?? 'null',
      ) as PlaybackStateRecord
      if (
        queueRecord?.storageVersion !== SPLIT_STORAGE_VERSION ||
        stateRecord?.storageVersion !== SPLIT_STORAGE_VERSION ||
        queueRecord.revision !== queueRevisionToRead ||
        stateRecord.revision !== stateRevisionToRead
      ) {
        return null
      }
      return parsePlayerQueueSnapshot({
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
    } catch {
      return null
    }
  }

  return {
    load() {
      try {
        const raw = storage.getItem(key)
        if (raw === null) return null
        const parsed = JSON.parse(raw) as UnknownRecord
        const parsedRevision = positiveInteger(parsed.revision) ? parsed.revision : null
        const parsedQueueRevision = positiveInteger(parsed.queueRevision)
          ? parsed.queueRevision
          : null
        const parsedStateRevision = positiveInteger(parsed.stateRevision)
          ? parsed.stateRevision
          : null
        const isSplit =
          parsed.storageVersion === SPLIT_STORAGE_VERSION && parsed.storage === 'split'
        const usesVersionedRecords =
          isSplit && parsedQueueRevision !== null && parsedStateRevision !== null
        let snapshot: PlayerQueueSnapshot | null
        let recoveredPreviousGeneration = false
        if (usesVersionedRecords) {
          queueRevision = parsedQueueRevision
          stateRevision = parsedStateRevision
          obsoleteQueueRevision = positiveInteger(parsed.previousQueueRevision)
            ? parsed.previousQueueRevision
            : 0
          obsoleteStateRevision = positiveInteger(parsed.previousStateRevision)
            ? parsed.previousStateRevision
            : 0
          snapshot = readVersionedSnapshot(parsedQueueRevision, parsedStateRevision)
          if (snapshot === null) {
            const previousQueueRevision = positiveInteger(parsed.previousQueueRevision)
              ? parsed.previousQueueRevision
              : parsedQueueRevision
            const previousStateRevision = positiveInteger(parsed.previousStateRevision)
              ? parsed.previousStateRevision
              : parsedStateRevision
            if (
              previousQueueRevision !== parsedQueueRevision ||
              previousStateRevision !== parsedStateRevision
            ) {
              snapshot = readVersionedSnapshot(previousQueueRevision, previousStateRevision)
              if (snapshot !== null) {
                queueRevision = previousQueueRevision
                stateRevision = previousStateRevision
                obsoleteQueueRevision = 0
                obsoleteStateRevision = 0
                recoveredPreviousGeneration = true
              }
            }
          }
        } else if (isSplit && parsedRevision !== null) {
          const queueRecord = JSON.parse(
            storage.getItem(queueKey) ?? 'null',
          ) as QueueStructureRecord
          const stateRecord = JSON.parse(storage.getItem(stateKey) ?? 'null') as PlaybackStateRecord
          if (
            queueRecord?.storageVersion !== SPLIT_STORAGE_VERSION ||
            stateRecord?.storageVersion !== SPLIT_STORAGE_VERSION ||
            queueRecord.revision !== parsedRevision ||
            stateRecord.revision !== parsedRevision
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
        } else if (usesVersionedRecords && recoveredPreviousGeneration) {
          // Keep the previous complete records in place. The next successful
          // save publishes a fresh marker and can then retire the incomplete
          // generation without losing the recovered snapshot.
          lastStructure = {
            queue: snapshot.queue,
            playNextQueue: snapshot.playNextQueue,
            playbackOrder: snapshot.playbackOrder,
            queueSource: snapshot.queueSource,
          }
        } else if (usesVersionedRecords) {
          // Rehydrate the in-memory bookkeeping as well as the public snapshot.
          // Without this, the first playback-only update after app restart is
          // treated as a structural change and serializes the entire queue again.
          queueRevision = parsedQueueRevision
          stateRevision = parsedStateRevision
          obsoleteQueueRevision = positiveInteger(parsed.previousQueueRevision)
            ? parsed.previousQueueRevision
            : 0
          obsoleteStateRevision = positiveInteger(parsed.previousStateRevision)
            ? parsed.previousStateRevision
            : 0
          lastStructure = {
            queue: snapshot.queue,
            playNextQueue: snapshot.playNextQueue,
            playbackOrder: snapshot.playbackOrder,
            queueSource: snapshot.queueSource,
          }
          removeObsoleteRecords()
        } else if (isSplit && parsedRevision !== null) {
          // Legacy fixed-key split records are intentionally rewritten on the
          // next save, but must not inherit bookkeeping from a previous record.
          queueRevision = 0
          stateRevision = 0
          obsoleteQueueRevision = 0
          obsoleteStateRevision = 0
          lastStructure = undefined
        } else {
          // Legacy combined records are intentionally rewritten on the next
          // save, but must not inherit bookkeeping from a split record.
          queueRevision = 0
          stateRevision = 0
          obsoleteQueueRevision = 0
          obsoleteStateRevision = 0
          lastStructure = undefined
        }
        return snapshot
      } catch {
        clearStoredRecords()
        return null
      }
    },
    save(snapshot) {
      const structureChanged =
        lastStructure === undefined ||
        lastStructure.queue !== snapshot.queue ||
        lastStructure.playNextQueue !== snapshot.playNextQueue ||
        lastStructure.playbackOrder !== snapshot.playbackOrder ||
        lastStructure.queueSource !== snapshot.queueSource
      const nextQueueRevision = structureChanged
        ? Math.max(1, queueRevision + 1)
        : Math.max(1, queueRevision)
      const nextStateRevision = Math.max(1, stateRevision + 1)
      const staleQueueRevision = structureChanged ? queueRevision : 0
      const staleStateRevision = stateRevision
      const storageKeys = new Set([
        key,
        queueKey,
        stateKey,
        versionedKey(queueKey, nextQueueRevision),
        versionedKey(stateKey, nextStateRevision),
      ])
      if (queueRevision > 0) storageKeys.add(versionedKey(queueKey, queueRevision))
      if (stateRevision > 0) storageKeys.add(versionedKey(stateKey, stateRevision))
      const previousValues = new Map(
        [...storageKeys].map((storageKey) => [storageKey, storage.getItem(storageKey)]),
      )
      const previousQueueRevision = queueRevision
      const previousStateRevision = stateRevision
      const previousObsoleteQueueRevision = obsoleteQueueRevision
      const previousObsoleteStateRevision = obsoleteStateRevision
      const previousStructure = lastStructure
      try {
        if (structureChanged) {
          const queueRecord: QueueStructureRecord = {
            storageVersion: SPLIT_STORAGE_VERSION,
            revision: nextQueueRevision,
            queue: snapshot.queue,
            playNextQueue: snapshot.playNextQueue,
            playbackOrder: snapshot.playbackOrder,
            queueSource: snapshot.queueSource,
          }
          storage.setItem(versionedKey(queueKey, nextQueueRevision), JSON.stringify(queueRecord))
        }

        const stateRecord: PlaybackStateRecord = {
          storageVersion: SPLIT_STORAGE_VERSION,
          revision: nextStateRevision,
          currentTrack: snapshot.currentTrack,
          currentIndex: snapshot.currentIndex,
          currentIsPlayNext: snapshot.currentIsPlayNext,
          repeatMode: snapshot.repeatMode,
          shuffle: snapshot.shuffle,
          reversed: snapshot.reversed,
          volume: snapshot.volume,
          progress: snapshot.progress,
        }
        storage.setItem(versionedKey(stateKey, nextStateRevision), JSON.stringify(stateRecord))
        storage.setItem(
          key,
          JSON.stringify({
            storageVersion: SPLIT_STORAGE_VERSION,
            storage: 'split',
            queueRevision: nextQueueRevision,
            stateRevision: nextStateRevision,
            previousQueueRevision: staleQueueRevision > 0 ? staleQueueRevision : null,
            previousStateRevision: staleStateRevision > 0 ? staleStateRevision : null,
          }),
        )
        queueRevision = nextQueueRevision
        stateRevision = nextStateRevision
        obsoleteQueueRevision = staleQueueRevision
        obsoleteStateRevision = staleStateRevision
        lastStructure = {
          queue: snapshot.queue,
          playNextQueue: snapshot.playNextQueue,
          playbackOrder: snapshot.playbackOrder,
          queueSource: snapshot.queueSource,
        }
        removeObsoleteRecords()
      } catch (error) {
        queueRevision = previousQueueRevision
        stateRevision = previousStateRevision
        obsoleteQueueRevision = previousObsoleteQueueRevision
        obsoleteStateRevision = previousObsoleteStateRevision
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
      clearStoredRecords(true)
    },
  }
}

export const noPlayerQueuePersistence: PlayerQueuePersistence = {
  load: () => null,
  save: () => undefined,
  clear: () => undefined,
}
