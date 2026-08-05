import { computed, markRaw, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import type { MusicQuality } from '@/features/settings/domain/settings'
import { preloadCoverImages } from '@/platform/cover-image'
import type { RepeatMode, Track } from '@/types/music'
import {
  releaseAudioSource,
  type AudioEngine,
  type AudioEngineState,
  type AudioSource,
} from '../domain/audio-engine'
import {
  createShuffledOrder,
  cycleRepeatMode as nextRepeatMode,
  extendShuffledOrder,
  pinCurrentInOrder,
  resolveQueueTrackIndex,
  upcomingQueueIndices,
  type QueueAdvanceReason,
  type QueueDirection,
} from '../domain/playback-queue'
import {
  createBrowserMediaSession,
  type MediaSessionTransport,
  type PlayerMediaSession,
} from '../infrastructure/browser-media-session'
import { HowlerAudioEngine } from '../infrastructure/howler-audio-engine'
import { nativeTrackLikeGateway, type TrackLikeGateway } from '../infrastructure/native-like'
import { emitTrackLikeChange } from './track-like-events'
import { playbackFrameScheduler } from './playback-frame-scheduler'
import {
  createLocalPlayerQueuePersistence,
  MAX_PERSISTED_PLAY_NEXT_TRACKS,
  MAX_PERSISTED_QUEUE_TRACKS,
  noPlayerQueuePersistence,
  PLAYER_QUEUE_SNAPSHOT_VERSION,
  type PlayerQueuePersistence,
  type PlayerQueueSnapshot,
} from '../infrastructure/queue-snapshot'

interface StreamGateway {
  resolveStream(trackId: number, quality: MusicQuality, signal?: AbortSignal): Promise<AudioSource>
}

type MediaSessionFactory = (transport: MediaSessionTransport) => PlayerMediaSession

function defaultQueuePersistence(storeId: string): PlayerQueuePersistence {
  if (storeId !== 'player') return noPlayerQueuePersistence
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      return createLocalPlayerQueuePersistence(globalThis.localStorage)
    }
  } catch {
    // Local storage can be disabled by the WebView policy.
  }
  return noPlayerQueuePersistence
}

function createEngine(): AudioEngine {
  return new HowlerAudioEngine()
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

export function createPlayerStore(
  engineFactory: () => AudioEngine = createEngine,
  streamGateway: StreamGateway = new NativeCatalogGateway(),
  random: () => number = Math.random,
  storeId = 'player',
  mediaSessionFactory: MediaSessionFactory = createBrowserMediaSession,
  likeGateway: TrackLikeGateway = nativeTrackLikeGateway,
  queuePersistence?: PlayerQueuePersistence,
) {
  return defineStore(storeId, () => {
    const engine = markRaw(engineFactory())
    const settingsStore = useSettingsStore()
    const persistence = queuePersistence ?? defaultQueuePersistence(storeId)
    let persistenceAvailable = true
    let loadedSnapshot: PlayerQueueSnapshot | null = null
    try {
      loadedSnapshot = persistence.load()
    } catch {
      persistenceAvailable = false
    }
    const restoredSnapshot = loadedSnapshot?.queueSource === 'personal-fm' ? null : loadedSnapshot
    if (loadedSnapshot !== null && restoredSnapshot === null) {
      try {
        persistence.clear()
      } catch {
        persistenceAvailable = false
      }
    }
    const state = ref<AudioEngineState>(engine.state)
    const currentTrack = shallowRef<Track | null>(restoredSnapshot?.currentTrack ?? null)
    const pendingTrack = shallowRef<Track | null>(null)
    const queue = shallowRef<readonly Track[]>(restoredSnapshot?.queue ?? [])
    const playNextQueue = shallowRef<readonly Track[]>(restoredSnapshot?.playNextQueue ?? [])
    const playbackOrder = shallowRef<readonly number[]>(restoredSnapshot?.playbackOrder ?? [])
    const queueSource = shallowRef<string | null>(restoredSnapshot?.queueSource ?? null)
    const currentIndex = ref(restoredSnapshot?.currentIndex ?? -1)
    const progress = ref(restoredSnapshot?.progress ?? 0)
    const seeking = ref(false)
    const duration = ref(0)
    const volume = ref(restoredSnapshot?.volume ?? 1)
    const repeatMode = ref<RepeatMode>(restoredSnapshot?.repeatMode ?? 'off')
    const shuffle = ref(restoredSnapshot?.shuffle ?? false)
    const reversed = ref(false)
    const error = shallowRef<Error | null>(null)
    const liked = ref<boolean | null>(null)
    const likeBusy = ref(false)
    const activeLoad = shallowRef<AbortController | null>(null)
    const queueBusy = ref(false)
    const queueLoadingTrackId = ref<number | null>(null)
    let currentIsPlayNext = restoredSnapshot?.currentIsPlayNext ?? false
    let restoredTrackPending = restoredSnapshot?.currentTrack != null
    let restoredProgress = restoredSnapshot?.progress ?? 0
    let persistenceTimer: ReturnType<typeof globalThis.setTimeout> | null = null
    let navigationController: AbortController | null = null
    let likeController: AbortController | null = null
    let likeStateVersion = 0
    let stopProgressSubscription: (() => void) | null = null
    const playing = computed(() => state.value === 'playing')
    const enabled = computed(() => currentTrack.value !== null)
    const upcomingTracks = computed(() =>
      upcomingQueueIndices(
        queue.value.length,
        currentIndex.value,
        playbackOrder.value,
        reversed.value,
      )
        .map((index) => queue.value[index])
        .filter((track): track is Track => track !== undefined),
    )
    const outputDeviceSelectionSupported = engine.supportsOutputDeviceSelection

    function cancelLike(reason: string): void {
      likeController?.abort(reason)
      likeController = null
      likeBusy.value = false
    }

    function refreshLikeState(track: Track): void {
      cancelLike('Track changed')
      // A track started from “我最喜欢” is known to be liked before the
      // network check returns. This avoids a visible empty-heart flash while
      // still letting NetEase remain the authoritative final answer.
      liked.value = queueSource.value?.startsWith('liked:') ? true : null
      const stateVersion = ++likeStateVersion
      const controller = new AbortController()
      likeController = controller
      likeBusy.value = true
      void likeGateway
        .check(track.id, controller.signal)
        .then((value) => {
          if (
            likeController === controller &&
            currentTrack.value?.id === track.id &&
            stateVersion === likeStateVersion
          ) {
            liked.value = value
          }
        })
        .catch((reason: unknown) => {
          if (
            !isAbort(reason) &&
            likeController === controller &&
            currentTrack.value?.id === track.id
          ) {
            error.value = asError(reason)
          }
        })
        .finally(() => {
          if (likeController === controller) {
            likeController = null
            likeBusy.value = false
          }
        })
    }

    function syncLikeState(trackId: number, value: boolean): void {
      if (currentTrack.value?.id !== trackId) return
      // A context-menu mutation can finish while the initial status check is
      // still in flight. Versioning prevents that stale check from repainting
      // the confirmed mutation with an old value.
      likeStateVersion += 1
      liked.value = value
    }

    const mediaSession = markRaw(
      mediaSessionFactory({
        async play() {
          if (!playing.value) await togglePlayback()
        },
        pause() {
          engine.pause()
        },
        previous,
        next,
        stop() {
          engine.pause()
        },
        seekTo: seek,
        seekBy(seconds) {
          seek(engine.currentTime + seconds)
        },
      }),
    )

    void engine
      .setOutputDevice(settingsStore.settings.outputDevice)
      .catch(async (reason: unknown) => {
        // A saved macOS device can disappear between launches. Keep playback usable by
        // falling back to the system output before surfacing a real device error.
        if (settingsStore.settings.outputDevice !== 'default') {
          try {
            await engine.setOutputDevice('default')
            settingsStore.update?.({ outputDevice: 'default' })
            return
          } catch {
            // Preserve the original error when the engine cannot select even the default.
          }
        }
        error.value = asError(reason)
      })
    engine.setVolume(volume.value)
    const playbackClock = markRaw({ read: () => engine.currentTime })
    const releasePlaybackClock = playbackFrameScheduler.setClock(playbackClock.read)

    const stopProgressClock = () => {
      stopProgressSubscription?.()
      stopProgressSubscription = null
    }

    const tickProgress = ({ currentTime }: { readonly currentTime: number }) => {
      if (Number.isFinite(currentTime)) progress.value = currentTime
    }

    const syncProgressClock = () => {
      stopProgressClock()
      if (playing.value && !document.hidden) {
        stopProgressSubscription = playbackFrameScheduler.subscribe(tickProgress, playbackClock.read)
      } else {
        playbackFrameScheduler.wake()
      }
    }

    const syncMediaPosition = (position = engine.currentTime) => {
      const track = currentTrack.value
      if (track === null) {
        mediaSession.setPositionState(0, 0)
        return
      }
      const mediaDuration =
        duration.value > 0 ? duration.value : Math.max(track.durationMs / 1000, 0)
      mediaSession.setPositionState(mediaDuration, position)
    }

    const syncMediaPlaybackState = (value = state.value) => {
      mediaSession.setPlaybackState(currentTrack.value === null ? 'idle' : value)
    }

    if (currentTrack.value) {
      mediaSession.setTrack(currentTrack.value)
      syncMediaPlaybackState()
      syncMediaPosition(progress.value)
    }

    const unsubscribers = [
      engine.subscribe('state', (value) => {
        state.value = value
        syncProgressClock()
        syncMediaPlaybackState(value)
        syncMediaPosition()
        if (value === 'ended') void advance('next', 'ended')
      }),
      engine.subscribe('duration', (value) => {
        duration.value = value
        syncMediaPosition()
      }),
      engine.subscribe('time', (value) => {
        if (!playing.value) progress.value = value
        syncMediaPosition(value)
      }),
      engine.subscribe('seeked', (value) => {
        seeking.value = false
        progress.value = value
        syncMediaPosition(value)
      }),
      engine.subscribe('volume', (value) => {
        volume.value = value
      }),
      engine.subscribe('error', (value) => {
        error.value = value
      }),
    ]

    const handleVisibilityChange = () => syncProgressClock()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    async function loadAudio(
      track: Track,
      source: AudioSource,
      autoplay = true,
      signal?: AbortSignal,
    ): Promise<void> {
      activeLoad.value?.abort('Track changed')
      const controller = new AbortController()
      activeLoad.value = controller
      error.value = null
      const forwardAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', forwardAbort, { once: true })
      if (signal?.aborted) forwardAbort()

      let sourceReleased = false
      const releaseSource = (): void => {
        if (sourceReleased || source.kind !== 'managed-url') return
        sourceReleased = true
        source.release()
      }
      const engineSource =
        source.kind === 'managed-url' ? { ...source, release: releaseSource } : source
      let sourceTransferred = false
      try {
        await engine.load(engineSource, controller.signal)
        sourceTransferred = true
        if (activeLoad.value !== controller) return
        currentTrack.value = track
        preloadCoverImages(track.album.coverUrl)
        restoredTrackPending = false
        restoredProgress = 0
        refreshLikeState(track)
        progress.value = 0
        duration.value = engine.duration
        mediaSession.setTrack(track)
        syncMediaPlaybackState()
        syncMediaPosition(0)
        if (autoplay) await engine.play()
      } finally {
        if (!sourceTransferred) releaseSource()
        signal?.removeEventListener('abort', forwardAbort)
        if (activeLoad.value === controller) activeLoad.value = null
      }
    }

    async function load(
      track: Track,
      source: AudioSource,
      autoplay = true,
      signal?: AbortSignal,
    ): Promise<void> {
      cancelNavigation('Direct track selection')
      pendingTrack.value = track
      try {
        await loadAudio(track, source, autoplay, signal)
      } finally {
        if (pendingTrack.value?.id === track.id) pendingTrack.value = null
      }
    }

    function rebuildPlaybackOrder(): void {
      playbackOrder.value = shuffle.value
        ? createShuffledOrder(queue.value.length, currentIndex.value, random, reversed.value)
        : []
    }

    function cancelNavigation(reason: string): void {
      navigationController?.abort(reason)
      navigationController = null
      queueBusy.value = false
      queueLoadingTrackId.value = null
      pendingTrack.value = null
    }

    function setQueue(
      tracks: readonly Track[],
      startIndex = 0,
      source: string | null = null,
    ): void {
      cancelNavigation('Queue replaced')
      queue.value = [...tracks]
      queueSource.value = source
      currentIndex.value =
        tracks.length === 0 ? -1 : Math.min(Math.max(startIndex, 0), tracks.length - 1)
      playNextQueue.value = []
      currentIsPlayNext = false
      rebuildPlaybackOrder()
    }

    function appendQueue(tracks: readonly Track[], expectedSource: string): boolean {
      if (queueSource.value !== expectedSource) return false
      const previousLength = queue.value.length
      const ids = new Set(queue.value.map(({ id }) => id))
      const additions = tracks.filter((track) => {
        if (ids.has(track.id)) return false
        ids.add(track.id)
        return true
      })
      if (additions.length > 0) {
        queue.value = [...queue.value, ...additions]
        if (shuffle.value) {
          playbackOrder.value = extendShuffledOrder(
            playbackOrder.value,
            previousLength,
            additions.length,
            currentIndex.value,
            reversed.value,
            random,
          )
        }
      }
      return true
    }

    async function loadResolvedTrack(track: Track, commit: () => void): Promise<boolean> {
      navigationController?.abort('Queue selection superseded')
      const controller = new AbortController()
      navigationController = controller
      queueBusy.value = true
      queueLoadingTrackId.value = track.id
      pendingTrack.value = track
      error.value = null
      try {
        const source = await streamGateway.resolveStream(
          track.id,
          settingsStore.settings.musicQuality,
          controller.signal,
        )
        if (navigationController !== controller) {
          releaseAudioSource(source)
          return false
        }
        await loadAudio(track, source, true, controller.signal)
        if (navigationController !== controller) return false
        commit()
        return true
      } catch (reason) {
        if (!isAbort(reason)) error.value = asError(reason)
        return false
      } finally {
        if (navigationController === controller) {
          navigationController = null
          queueBusy.value = false
          queueLoadingTrackId.value = null
          pendingTrack.value = null
        }
      }
    }

    async function playQueueIndex(index: number): Promise<boolean> {
      const track = queue.value[index]
      if (!track?.playable) return false
      return loadResolvedTrack(track, () => {
        currentIndex.value = index
        currentIsPlayNext = false
      })
    }

    function playQueueTrack(trackId: number): Promise<boolean> {
      return playQueueIndex(queue.value.findIndex(({ id }) => id === trackId))
    }

    function addPlayNext(track: Track): boolean {
      if (!track.playable || playNextQueue.value.length >= MAX_PERSISTED_PLAY_NEXT_TRACKS) {
        return false
      }
      playNextQueue.value = [...playNextQueue.value, track]
      return true
    }

    function clearPlayNext(): void {
      if (queueBusy.value) return
      playNextQueue.value = []
    }

    function removePlayNextAt(index: number): boolean {
      if (queueBusy.value) return false
      if (index < 0 || index >= playNextQueue.value.length) return false
      playNextQueue.value = playNextQueue.value.filter((_, itemIndex) => itemIndex !== index)
      return true
    }

    async function playPlayNextAt(index: number): Promise<boolean> {
      const track = playNextQueue.value[index]
      if (!track?.playable) return false
      return loadResolvedTrack(track, () => {
        const pending = [...playNextQueue.value]
        if (pending[index]?.id === track.id) pending.splice(index, 1)
        else {
          const currentPosition = pending.indexOf(track)
          if (currentPosition >= 0) pending.splice(currentPosition, 1)
        }
        playNextQueue.value = pending
        currentIsPlayNext = true
      })
    }

    async function repeatCurrent(): Promise<boolean> {
      if (currentTrack.value === null) return false
      try {
        seek(0)
        await engine.play()
        return true
      } catch (reason) {
        error.value = asError(reason)
        return false
      }
    }

    async function advance(
      direction: QueueDirection,
      reason: QueueAdvanceReason = 'manual',
    ): Promise<boolean> {
      if (reason === 'ended' && queueBusy.value) return false
      if (reason === 'ended' && repeatMode.value === 'one') return repeatCurrent()
      if (direction === 'next' && playNextQueue.value.length > 0) return playPlayNextAt(0)
      if (direction === 'previous' && currentIsPlayNext) {
        const baseTrack = queue.value[currentIndex.value]
        if (!baseTrack?.playable) return false
        return loadResolvedTrack(baseTrack, () => {
          currentIsPlayNext = false
        })
      }
      const index = resolveQueueTrackIndex(
        {
          length: queue.value.length,
          currentIndex: currentIndex.value,
          repeatMode: repeatMode.value,
          reversed: reversed.value,
        },
        playbackOrder.value,
        direction,
        reason,
      )
      return index === null ? false : playQueueIndex(index)
    }

    function next(reason: QueueAdvanceReason = 'manual'): Promise<boolean> {
      return advance('next', reason)
    }

    function previous(): Promise<boolean> {
      return advance('previous')
    }

    async function togglePlayback(): Promise<void> {
      if (playing.value) {
        engine.pause()
      } else if (restoredTrackPending && currentTrack.value) {
        const track = currentTrack.value
        const resumeAt = restoredProgress
        navigationController?.abort('Restored playback superseded')
        const controller = new AbortController()
        navigationController = controller
        queueBusy.value = true
        queueLoadingTrackId.value = track.id
        pendingTrack.value = track
        error.value = null
        try {
          const source = await streamGateway.resolveStream(
            track.id,
            settingsStore.settings.musicQuality,
            controller.signal,
          )
          if (navigationController !== controller) {
            releaseAudioSource(source)
            return
          }
          await loadAudio(track, source, false, controller.signal)
          if (navigationController !== controller) return
          if (resumeAt > 0) seek(resumeAt)
          await engine.play()
        } catch (reason) {
          if (!isAbort(reason)) error.value = asError(reason)
        } finally {
          if (navigationController === controller) {
            navigationController = null
            queueBusy.value = false
            queueLoadingTrackId.value = null
            pendingTrack.value = null
          }
        }
      } else {
        await engine.play()
      }
    }

    function seek(seconds: number): void {
      if (!Number.isFinite(seconds)) return
      const upperBound = duration.value || (currentTrack.value?.durationMs ?? 0) / 1_000
      const nextPosition = Math.min(Math.max(seconds, 0), upperBound || Number.POSITIVE_INFINITY)
      if (restoredTrackPending) {
        restoredProgress = nextPosition
        progress.value = nextPosition
        syncMediaPosition(nextPosition)
        return
      }
      seeking.value = true
      engine.seek(nextPosition)
      progress.value = engine.currentTime
      syncMediaPosition(engine.currentTime)
    }

    // Read the media element directly, matching the legacy player's seek(null)
    // behavior for lyric synchronization after a seek.
    function readCurrentTime(): number {
      const value = readPlaybackTime()
      if (!playing.value) progress.value = value
      return value
    }

    function readPlaybackTime(): number {
      return playbackClock.read()
    }

    function setVolume(value: number): void {
      engine.setVolume(value)
    }

    async function toggleLike(): Promise<boolean> {
      const track = currentTrack.value
      if (track === null || likeBusy.value) return false
      likeController?.abort('Like request superseded')
      const controller = new AbortController()
      likeController = controller
      likeBusy.value = true
      let rollbackState = liked.value
      try {
        const currentLiked = liked.value ?? (await likeGateway.check(track.id, controller.signal))
        if (currentTrack.value?.id !== track.id || likeController !== controller) return false
        rollbackState = currentLiked
        likeStateVersion += 1
        liked.value = !currentLiked
        const nextLiked = await likeGateway.setLiked(track.id, !currentLiked, controller.signal)
        if (currentTrack.value?.id === track.id && likeController === controller) {
          liked.value = nextLiked
          emitTrackLikeChange({ track, liked: nextLiked })
        }
        return nextLiked
      } catch (reason) {
        if (!isAbort(reason)) {
          if (currentTrack.value?.id === track.id && likeController === controller) {
            liked.value = rollbackState
          }
          error.value = asError(reason)
        }
        return false
      } finally {
        if (likeController === controller) {
          likeController = null
          likeBusy.value = false
        }
      }
    }

    async function setOutputDevice(deviceId: string): Promise<void> {
      await engine.setOutputDevice(deviceId)
    }

    function cycleRepeatMode(): void {
      repeatMode.value = nextRepeatMode(repeatMode.value)
    }

    function toggleShuffle(): void {
      shuffle.value = !shuffle.value
      rebuildPlaybackOrder()
    }

    function toggleReversed(): void {
      reversed.value = !reversed.value
      if (shuffle.value) {
        playbackOrder.value = pinCurrentInOrder(
          playbackOrder.value,
          queue.value.length,
          currentIndex.value,
          reversed.value,
        )
      }
    }

    function snapshot(): PlayerQueueSnapshot | null {
      if (
        queue.value.length > MAX_PERSISTED_QUEUE_TRACKS ||
        playNextQueue.value.length > MAX_PERSISTED_PLAY_NEXT_TRACKS
      ) {
        return null
      }
      const trackMatchesQueue =
        currentTrack.value === null ||
        currentIsPlayNext ||
        queue.value[currentIndex.value]?.id === currentTrack.value.id
      return {
        version: PLAYER_QUEUE_SNAPSHOT_VERSION,
        queue: queue.value,
        playNextQueue: playNextQueue.value,
        currentTrack: trackMatchesQueue ? currentTrack.value : null,
        currentIndex: currentIndex.value,
        currentIsPlayNext: trackMatchesQueue && currentIsPlayNext,
        queueSource: queueSource.value,
        playbackOrder: playbackOrder.value,
        repeatMode: repeatMode.value,
        shuffle: shuffle.value,
        reversed: reversed.value,
        volume: volume.value,
        progress: trackMatchesQueue ? progress.value : 0,
      }
    }

    function persistQueueNow(): void {
      if (!persistenceAvailable) return
      if (persistenceTimer !== null) globalThis.clearTimeout(persistenceTimer)
      persistenceTimer = null
      try {
        const value = snapshot()
        if (value === null || (value.queue.length === 0 && value.currentTrack === null)) {
          persistence.clear()
        } else {
          persistence.save(value)
        }
      } catch {
        persistenceAvailable = false
      }
    }

    function scheduleQueuePersistence(): void {
      if (!persistenceAvailable) return
      if (persistenceTimer !== null) globalThis.clearTimeout(persistenceTimer)
      persistenceTimer = globalThis.setTimeout(persistQueueNow, 250)
    }

    const stopQueuePersistence = watch(
      [
        queue,
        playNextQueue,
        currentTrack,
        currentIndex,
        queueSource,
        playbackOrder,
        repeatMode,
        shuffle,
        reversed,
        volume,
        state,
      ],
      scheduleQueuePersistence,
    )

    function dispose(): void {
      persistQueueNow()
      stopQueuePersistence()
      cancelNavigation('Player disposed')
      activeLoad.value?.abort('Player disposed')
      activeLoad.value = null
      cancelLike('Player disposed')
      stopProgressClock()
      releasePlaybackClock()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      for (const unsubscribe of unsubscribers) unsubscribe()
      mediaSession.dispose()
      engine.dispose()
    }

    onScopeDispose(dispose)

    return {
      state,
      currentTrack,
      pendingTrack,
      queue,
      playNextQueue,
      upcomingTracks,
      queueSource,
      currentIndex,
      progress,
      duration,
      volume,
      repeatMode,
      shuffle,
      reversed,
      error,
      seeking,
      liked,
      likeBusy,
      playing,
      enabled,
      queueBusy,
      queueLoadingTrackId,
      outputDeviceSelectionSupported,
      load,
      setQueue,
      appendQueue,
      playQueueIndex,
      playQueueTrack,
      addPlayNext,
      clearPlayNext,
      removePlayNextAt,
      playPlayNextAt,
      next,
      previous,
      togglePlayback,
      seek,
      readCurrentTime,
      readPlaybackTime,
      playbackClock,
      setVolume,
      toggleLike,
      syncLikeState,
      setOutputDevice,
      cycleRepeatMode,
      toggleShuffle,
      toggleReversed,
      dispose,
    }
  })
}

export const usePlayerStore = createPlayerStore()
