<template>
  <footer
    class="player-bar"
    data-tauri-drag-region
    :class="{ disabled: !player.enabled, 'is-transitioning': isTransitioning }"
    :aria-busy="isTransitioning"
  >
    <div class="player-controls">
      <div class="track" :class="{ transitioning: isTransitioning }">
        <RouterLink
          v-if="displayTrack"
          class="track-cover-link"
          :to="`/album/${displayTrack.album.id}`"
          :aria-label="displayTrack.album.name"
          :title="displayTrack.album.name"
        >
          <CoverImage
            class="track-cover"
            :source="displayTrack.album.coverUrl"
            :width="64"
            alt=""
            decoding="async"
          />
        </RouterLink>
        <div v-else class="cover-placeholder"></div>
        <div class="metadata" aria-live="polite">
          <strong>{{ displayTrack?.name ?? 'Clarus Music' }}</strong>
          <span>
            <template v-if="isTransitioning">{{ t('player.loading') }} · </template>
            {{ trackSubtitle }}
          </span>
        </div>
      </div>

      <div class="transport-stack">
        <div class="transport">
          <IconButton
            icon="shuffle"
            :title="t('player.shuffle')"
            :class="{ active: player.shuffle }"
            :aria-pressed="player.shuffle"
            @click="player.toggleShuffle"
          />
          <IconButton
            icon="previous"
            :title="t('player.previous')"
            :disabled="!player.enabled"
            @click="previous"
          />
          <IconButton
            class="play-button"
            :icon="player.playing ? 'pause' : 'play'"
            :title="t(player.playing ? 'player.pause' : 'player.play')"
            :disabled="!player.enabled || isTransitioning"
            @click="player.togglePlayback"
          />
          <IconButton
            icon="next"
            :title="t('player.next')"
            :disabled="!player.enabled"
            @click="next"
          />
          <IconButton
            :icon="player.repeatMode === 'one' ? 'repeat-1' : 'repeat'"
            :title="t(player.repeatMode === 'one' ? 'player.repeatTrack' : 'player.repeat')"
            :class="{ active: player.repeatMode !== 'off' }"
            :aria-pressed="player.repeatMode !== 'off'"
            @click="cycleRepeat"
          />
        </div>
        <div class="progress-row">
          <span>{{ formatTime(displayedProgress) }}</span>
          <input
            class="progress"
            type="range"
            min="0"
            :max="Math.max(displayDuration, 1)"
            step="0.1"
            :value="displayedProgress"
            :style="rangeStyle(displayedProgress, displayDuration)"
            aria-label="Playback progress"
            :disabled="isTransitioning"
            @pointerdown="beginSeek"
            @input="previewSeek"
            @change="commitSeek"
            @pointercancel="cancelSeek"
          />
          <span>{{ formatTime(displayDuration) }}</span>
        </div>
      </div>

      <div class="secondary-controls">
        <IconButton
          icon="list"
          :title="t('player.nextUp')"
          :class="{ active: route.name === 'next' }"
          @click="openQueue"
        />
        <IconButton
          :icon="player.liked === true ? 'heart-solid' : 'heart'"
          :title="likeTitle"
          :disabled="!player.enabled || isTransitioning || player.likeBusy"
          :class="{ active: player.liked === true, checking: player.liked === null }"
          @click="toggleLike"
        />
        <IconButton
          icon="plus"
          :title="t('player.addToPlaylist')"
          :disabled="!player.enabled || isTransitioning || playlistPickerLoading"
          @click="openPlaylistPicker"
        />
        <span class="volume-icon-control" data-no-window-drag aria-hidden="true">
          <AppIcon class="volume-icon" :name="player.volume === 0 ? 'volume-mute' : 'volume'" />
        </span>
        <input
          class="volume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="player.volume"
          :style="rangeStyle(player.volume, 1)"
          aria-label="Volume"
          @input="changeVolume"
        />
        <IconButton
          icon="arrow-up"
          :title="t('player.lyrics')"
          :disabled="!player.enabled"
          @click="lyricsStore.open"
        />
      </div>
    </div>
  </footer>

  <Transition name="floating-dialog">
    <div
      v-if="playlistPickerOpen"
      class="playlist-picker-backdrop"
      role="presentation"
      @pointerdown.self="closePlaylistPicker"
    >
      <section class="playlist-picker" role="dialog" aria-modal="true">
        <header>
          <h2>{{ t('player.selectPlaylist') }}</h2>
          <IconButton icon="x" :title="t('player.close')" @click="closePlaylistPicker" />
        </header>
        <p v-if="playlistPickerError" class="picker-error" role="alert">
          {{ playlistPickerError }}
        </p>
        <div v-if="playlistPickerLoading" class="picker-state" role="status">
          {{ t('player.loading') }}
        </div>
        <div v-else-if="playlistOptions.length" class="playlist-options">
          <button
            v-for="playlist in playlistOptions"
            :key="playlist.id"
            type="button"
            :disabled="playlistMutationId !== null"
            @click="addCurrentTrackToPlaylist(playlist.id)"
          >
            <CoverImage :source="playlist.coverUrl" :width="64" alt="" loading="lazy" />
            <span>{{ playlist.name }}</span>
            <span
              v-if="playlistMutationId === playlist.id"
              class="spinner"
              aria-hidden="true"
            ></span>
          </button>
        </div>
        <div v-else class="picker-state">{{ t('player.noPlaylists') }}</div>
        <p v-if="playlistPickerFeedback" class="picker-feedback" role="status">
          {{ playlistPickerFeedback }}
        </p>
      </section>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToastStore } from '@/app/toast-store'
import CoverImage from '@/components/common/CoverImage.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import IconButton from '@/components/common/IconButton.vue'
import { useLyricsStore } from '@/features/lyrics/application/lyrics-store'
import { usePlayerStore } from '@/features/player/application/player-store'
import { useAuthStore } from '@/features/auth/application/auth-store'
import { NativeLibraryGateway } from '@/features/library/infrastructure/native-library'
import { NativePlaylistGateway } from '@/features/playlist/infrastructure/native-playlist'
import type { LibraryPlaylist } from '@/features/library/domain/library'
import { formatArtists } from '@/types/music'

const player = usePlayerStore()
const lyricsStore = useLyricsStore()
const authStore = useAuthStore()
const libraryGateway = new NativeLibraryGateway()
const playlistGateway = new NativePlaylistGateway()
const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const toast = useToastStore()
const displayTrack = computed(() => player.pendingTrack ?? player.currentTrack)
const isTransitioning = computed(() => player.pendingTrack != null)
const displayDuration = computed(() =>
  isTransitioning.value ? (displayTrack.value?.durationMs ?? 0) / 1_000 : player.duration,
)
const playbackProgress = computed(() => (isTransitioning.value ? 0 : player.progress))
const trackSubtitle = computed(() => {
  const track = displayTrack.value
  if (!track) return 'Your music, clearly'
  return [formatArtists(track.artists), track.album.name].filter(Boolean).join(' · ')
})
const likeTitle = computed(() =>
  player.likeBusy && player.liked === null
    ? t('player.checkingLike')
    : t(player.liked === true ? 'player.unlike' : 'player.like'),
)
const playlistPickerOpen = ref(false)
const playlistPickerLoading = ref(false)
const playlistPickerError = shallowRef<string | null>(null)
const playlistPickerFeedback = shallowRef<string | null>(null)
const playlistOptions = shallowRef<readonly LibraryPlaylist[]>([])
const playlistMutationId = ref<number | null>(null)
const seekPreview = ref<number | null>(null)
const displayedProgress = computed(() => seekPreview.value ?? playbackProgress.value)
let playlistPickerController: AbortController | null = null
let playlistMutationController: AbortController | null = null
let reportedPlayerError: Error | null = null

watch(
  () => player.error,
  (error) => {
    if (error === null) {
      reportedPlayerError = null
      return
    }
    if (error !== reportedPlayerError) {
      reportedPlayerError = error
      toast.show(error.message)
    }
  },
)

function readRangeValue(event: Event): number | null {
  const value = Number((event.target as HTMLInputElement | null)?.value)
  return Number.isFinite(value) ? value : null
}

function beginSeek(event: Event): void {
  seekPreview.value = readRangeValue(event)
}

function previewSeek(event: Event): void {
  const value = readRangeValue(event)
  if (value !== null) seekPreview.value = value
}

function commitSeek(event: Event): void {
  const value = readRangeValue(event) ?? seekPreview.value
  seekPreview.value = null
  if (value === null) return
  player.seek(value)
  if (player.enabled && !player.playing) void player.togglePlayback()
}

function cancelSeek(): void {
  seekPreview.value = null
}

function changeVolume(event: Event): void {
  player.setVolume(Number((event.target as HTMLInputElement).value))
}

function rangeStyle(value: number, maximum: number): Record<string, string> {
  const normalized = Number.isFinite(value) && maximum > 0 ? value / maximum : 0
  const percentage = Math.min(Math.max(normalized, 0), 1) * 100
  return { '--range-progress': `${percentage}%` }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function previous(): void {
  void player.previous()
}

function next(): void {
  void player.next()
}

async function toggleLike(): Promise<void> {
  const before = player.liked
  await player.toggleLike()
  if (player.liked === before || player.liked === null) {
    toast.show(t('player.likeFailed'))
    return
  }
  toast.show(t(player.liked ? 'player.liked' : 'player.unliked'))
}

function openQueue(): void {
  if (route.name === 'next') router.back()
  else void router.push('/next')
}

function cycleRepeat(): void {
  player.cycleRepeatMode()
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

async function openPlaylistPicker(): Promise<void> {
  const user = authStore.session.user
  if (!player.currentTrack) return
  if (!user) {
    await router.push('/login/account')
    return
  }
  playlistPickerController?.abort('Playlist picker superseded')
  const controller = new AbortController()
  playlistPickerController = controller
  playlistPickerOpen.value = true
  playlistPickerLoading.value = true
  playlistPickerError.value = null
  playlistPickerFeedback.value = null
  try {
    const page = await libraryGateway.playlistPage(user.userId, 0, controller.signal)
    if (playlistPickerController !== controller) return
    playlistOptions.value = page.items.filter(
      (playlist) => playlist.creatorId === user.userId && playlist.id !== page.items[0]?.id,
    )
  } catch (reason) {
    if (!isAbort(reason)) playlistPickerError.value = message(reason)
  } finally {
    if (playlistPickerController === controller) {
      playlistPickerController = null
      playlistPickerLoading.value = false
    }
  }
}

function closePlaylistPicker(): void {
  if (playlistMutationId.value !== null) return
  playlistPickerController?.abort('Playlist picker closed')
  playlistPickerOpen.value = false
  playlistPickerFeedback.value = null
}

async function addCurrentTrackToPlaylist(playlistId: number): Promise<void> {
  const track = player.currentTrack
  if (!track || playlistMutationId.value !== null) return
  playlistMutationController?.abort('Playlist mutation superseded')
  const controller = new AbortController()
  playlistMutationController = controller
  playlistMutationId.value = playlistId
  playlistPickerError.value = null
  playlistPickerFeedback.value = null
  try {
    await playlistGateway.addTracks(playlistId, [track.id], controller.signal)
    if (playlistMutationController !== controller) return
    playlistPickerFeedback.value = t('player.addedToPlaylist')
  } catch (reason) {
    if (!isAbort(reason)) playlistPickerError.value = message(reason)
  } finally {
    if (playlistMutationController === controller) {
      playlistMutationController = null
      playlistMutationId.value = null
    }
  }
}

onBeforeUnmount(() => {
  playlistPickerController?.abort('Player bar disposed')
  playlistMutationController?.abort('Player bar disposed')
})
</script>

<style scoped lang="scss">
.player-bar {
  position: fixed;
  z-index: var(--z-player);
  right: 0;
  bottom: 0;
  left: var(--sidebar-width);
  height: var(--player-height);
  border-top: 0;
  color: var(--color-text);
  background: var(--color-player-bg);
}

.player-controls {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(330px, 1.18fr) minmax(260px, 1fr);
  height: 100%;
  padding: 0 26px;
  align-items: center;
  gap: 22px;
}

.track,
.transport,
.secondary-controls {
  display: flex;
  align-items: center;
}

.player-bar :deep(.icon-button.active) {
  color: var(--color-toggle-active);
  background: transparent;
  opacity: 1;
}

.player-bar :deep(.icon-button.active:hover:not(:disabled)),
.player-bar :deep(.icon-button.active:focus-visible:not(:disabled)),
.player-bar :deep(.icon-button.active:active:not(:disabled)) {
  color: var(--color-toggle-active);
  background: transparent;
  opacity: 1;
}

.cover-placeholder,
.track-cover-link {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  border-radius: var(--radius-sm);
}

.cover-placeholder {
  background: var(--color-primary-gradient);
}

.track-cover-link {
  display: block;
  overflow: hidden;
  background: var(--color-secondary-bg);
  transition:
    opacity var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-out);

  &:hover {
    .track-cover {
      transform: scale(1.045);
    }
  }

  &:focus-visible {
    outline: 1px solid var(--color-text);
    outline-offset: 2px;
  }

  &:active {
    transform: scale(0.97);
  }
}

.track-cover {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--motion-fast) var(--ease-out);
}

.volume-icon-control {
  display: inline-flex;
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
  transform-origin: center;
  transition: transform var(--motion-hover-emphasis) var(--ease-out);

  &:hover {
    transform: scale(var(--scale-hover-icon));
  }
}

.volume-icon {
  pointer-events: none;
}

.metadata {
  display: flex;
  min-width: 0;
  margin-left: 11px;
  flex-direction: column;
  gap: 3px;

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 14px;
    font-weight: var(--font-weight-medium);
    letter-spacing: -0.008em;
  }

  span {
    color: var(--color-text-secondary);
    font-size: 11px;
  }
}

.track.transitioning {
  .track-cover-link,
  .metadata {
    animation: track-handoff 180ms var(--ease-out) both;
  }

  .metadata > span {
    color: var(--color-primary);
  }
}

.transport-stack {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 0;
}

.transport {
  justify-content: center;
  gap: 4px;

  :deep(.icon-button) {
    width: 32px;
    height: 32px;
    padding: 7px;
  }
}

.play-button {
  width: 32px !important;
  height: 32px !important;
  margin: 0 4px;
  border-radius: 5px;
  color: var(--color-primary);
  background: transparent;
  opacity: 1;

  &:hover:not(:disabled),
  &:focus-visible:not(:disabled) {
    color: var(--color-primary);
    background: transparent;
  }
}

.progress-row {
  display: grid;
  grid-template-columns: 32px minmax(110px, 1fr) 32px;
  align-items: center;
  gap: 8px;

  span {
    color: var(--color-text-secondary);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
}

.progress {
  width: 100%;
  height: 14px;
  margin: 0;
  cursor: pointer;
  touch-action: none;
}

.secondary-controls {
  justify-content: flex-end;
  gap: 2px;

  :deep(.icon-button) {
    width: 32px;
    height: 32px;
    padding: 7px;
  }

  > .volume-icon-control {
    margin-left: 6px;
    opacity: 0.72;
  }

  :deep(.icon-button.checking) {
    animation: like-checking 800ms ease-in-out infinite alternate;
  }
}

.volume {
  width: 72px;
  height: 14px;
}

.disabled .transport,
.disabled .progress {
  opacity: 0.42;
}

.disabled .track {
  opacity: 0.7;
}

@keyframes like-checking {
  to {
    opacity: 0.3;
  }
}

@keyframes track-handoff {
  from {
    opacity: 0.48;
    transform: translateY(2px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.playlist-picker-backdrop {
  position: fixed;
  z-index: var(--z-overlay);
  inset: 0;
  display: grid;
  padding: 24px;
  background: var(--color-overlay-scrim);
  place-items: center;
}

.playlist-picker {
  width: min(420px, 100%);
  max-height: min(560px, 80vh);
  overflow: auto;
  padding: 16px;
  border-radius: var(--floating-dialog-radius);
  color: var(--color-text);
  background: var(--color-surface-raised);
  box-shadow: var(--floating-dialog-shadow);

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: 18px;
  }
}

.playlist-options {
  display: grid;
  gap: 4px;
  margin-top: 12px;

  button {
    display: flex;
    position: relative;
    z-index: 0;
    min-height: 48px;
    padding: 6px;
    border: 0;
    border-radius: 5px;
    align-items: center;
    gap: 10px;
    color: inherit;
    background: transparent;
    text-align: left;

    transition: transform var(--motion-hover-emphasis) var(--ease-out);
    transform-origin: center;

    &:hover {
      background: transparent;
      transform: scale(var(--scale-hover-row));
      z-index: 2;
    }

    &:focus-visible:not(:hover) {
      background: transparent;
      transform: none;
      z-index: 1;
      will-change: auto;
    }

    &:active:not(:disabled) {
      transform: scale(var(--scale-hover-row));
    }

    img {
      width: 36px;
      height: 36px;
      border-radius: 5px;
      object-fit: cover;
    }

    span:first-of-type {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .spinner {
      width: 14px;
      height: 14px;
      margin-left: auto;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .playlist-options button {
    transition: none;

    &:hover,
    &:focus-visible,
    &:active {
      transform: none;
      will-change: auto;
    }
  }
}

.picker-state,
.picker-error,
.picker-feedback {
  margin: 12px 0 0;
  font-size: 13px;
}

.picker-error {
  color: var(--color-danger);
}

.picker-feedback {
  color: var(--color-primary);
}

@media (max-width: 1336px) {
  .player-controls {
    grid-template-columns: minmax(190px, 0.9fr) minmax(290px, 1.1fr) minmax(220px, 0.9fr);
    padding: 0 18px;
    gap: 12px;
  }

  .secondary-controls {
    :deep(.icon-button) {
      width: 28px;
      height: 28px;
      padding: 7px;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .volume-icon-control {
    transition: none;

    &:hover {
      transform: none;
      will-change: auto;
    }
  }
}
</style>
