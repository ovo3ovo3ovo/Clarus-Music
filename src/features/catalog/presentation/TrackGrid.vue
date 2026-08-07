<template>
  <div class="track-grid">
    <article
      v-for="(track, index) in tracks"
      :key="track.id"
      v-memo="rowMemo(track, index)"
      class="track-row"
      :class="{
        playing: track.id === activeTrackId,
        unavailable: !track.playable,
      }"
      :title="track.unavailableReason ?? undefined"
      @dblclick="play(track, index)"
      @contextmenu.prevent.stop="openContextMenu($event, track, index)"
    >
      <RouterLink
        class="track-cover"
        :to="`/album/${track.album.id}`"
        :aria-label="track.album.name"
        @dblclick.stop
      >
        <CoverImage
          :source="track.album.coverUrl"
          :width="224"
          :alt="track.album.name"
          loading="lazy"
          decoding="async"
        />
      </RouterLink>
      <div class="track-copy">
        <strong>
          {{ track.name }}
          <span v-if="subtitle(track)" class="alias">({{ subtitle(track) }})</span>
        </strong>
        <span class="artists">
          <template v-for="(artist, artistIndex) in track.artists" :key="artist.id">
            <span v-if="artistIndex > 0">, </span>
            <RouterLink :to="`/artist/${artist.id}`" @dblclick.stop>{{ artist.name }}</RouterLink>
          </template>
        </span>
      </div>
      <button
        class="play-track"
        type="button"
        :title="t('search.playTrack')"
        :disabled="!track.playable || busyTrackId !== null"
        @click="play(track, index)"
        @dblclick.stop
      >
        <span
          v-if="track.id === busyTrackId || track.id === pendingTrackId"
          class="spinner"
          aria-hidden="true"
        ></span>
        <AppIcon v-else :name="track.id === activeTrackId ? 'volume' : 'play'" />
      </button>
    </article>
  </div>
  <TrackContextMenu
    :track="contextTrack"
    :position="contextPosition"
    @close="closeContextMenu"
    @play="playFromContext"
  />
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import { trackSubtitle } from '@/features/catalog/domain/track-subtitle'
import TrackContextMenu from '@/features/search/presentation/TrackContextMenu.vue'
import { trackContextPosition } from '@/features/search/presentation/track-context-position'
import type { Track } from '@/types/music'

const props = defineProps<{
  tracks: readonly Track[]
  currentTrackId: number | null
  busyTrackId: number | null
  pendingTrackId?: number | null
}>()

const emit = defineEmits<{
  play: [track: Track, index: number]
}>()
const { t, locale } = useI18n()
const activeTrackId = computed(() => props.pendingTrackId ?? props.currentTrackId)
const contextTrack = shallowRef<Track | null>(null)
const contextIndex = ref(-1)
const contextPosition = shallowRef<{ x: number; y: number } | null>(null)

function subtitle(track: Track): string {
  return trackSubtitle(track)
}

// Playback state changes on just one or two rows.  Avoid diffing every card
// in an overview result when the active/busy row changes.
function rowMemo(track: Track, index: number): unknown[] {
  return [
    track,
    index,
    track.id === activeTrackId.value,
    track.id === props.busyTrackId,
    track.id === props.pendingTrackId,
    locale.value,
  ]
}

function play(track: Track, index: number): void {
  if (track.playable) emit('play', track, index)
}

function openContextMenu(event: globalThis.MouseEvent, track: Track, index: number): void {
  contextTrack.value = track
  contextIndex.value = index
  contextPosition.value = trackContextPosition(
    event.clientX,
    event.clientY,
    window.innerWidth,
    window.innerHeight,
  )
}

function closeContextMenu(): void {
  contextTrack.value = null
  contextIndex.value = -1
  contextPosition.value = null
}

function playFromContext(track: Track): void {
  const index = contextIndex.value
  closeContextMenu()
  if (index >= 0) play(track, index)
}
</script>

<style scoped lang="scss">
.track-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 2px;
}

.track-row {
  display: grid;
  position: relative;
  z-index: 0;
  min-width: 0;
  height: 54px;
  padding: 5px;
  border: 0;
  border-radius: 5px;
  grid-template-columns: 40px minmax(0, 1fr) 28px;
  align-items: center;
  color: var(--color-text);
  background: transparent;
  content-visibility: auto;
  contain-intrinsic-size: 54px;
  transition: transform var(--motion-hover-emphasis) var(--ease-out);
  transform-origin: center;

  &:hover {
    background: transparent;
    transform: scale(var(--scale-hover-row));
    z-index: 2;
  }

  &:focus-within:not(:hover) {
    background: transparent;
    transform: none;
    z-index: 1;
  }

  &.playing {
    color: var(--color-primary);
    background: transparent;
  }

  &.unavailable {
    opacity: 0.38;
  }
}

.track-cover {
  width: 40px;
  height: 40px;

  img {
    display: block;
    width: 100%;
    height: 100%;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    object-fit: cover;
  }
}

.track-copy {
  display: flex;
  min-width: 0;
  padding: 0 9px;
  flex-direction: column;

  strong,
  .artists {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 13px;
    font-weight: var(--font-weight-regular);
    letter-spacing: -0.012em;
    line-height: 16px;
  }

  .alias {
    margin-left: 3px;
    color: var(--color-text-secondary);
    font-weight: var(--font-weight-regular);
    opacity: 0.7;
  }

  .artists {
    margin-top: 0;
    font-size: 11px;
    line-height: 14px;
    opacity: 0.68;
  }
}

.play-track {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  place-items: center;
  color: var(--color-primary);
  background: transparent;
  opacity: 0;
  transition: opacity var(--motion-fast) ease;

  .app-icon,
  .spinner {
    width: 14px;
    height: 14px;
  }

  .app-icon {
    transform-origin: center;
    transition: transform var(--motion-hover-emphasis) var(--ease-out);
    pointer-events: none;
  }

  &:hover:not(:disabled) {
    background: transparent;

    .app-icon {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:focus-visible:not(:disabled):not(:hover) {
    background: transparent;

    .app-icon {
      transform: none;
    }
  }

  &:active:not(:disabled) {
    .app-icon {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:disabled {
    opacity: 0;
  }
}

.track-row:hover .play-track,
.track-row:focus-within .play-track,
.track-row.playing .play-track {
  opacity: 1;
}

.spinner {
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 600ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  .track-row,
  .play-track {
    transition: none;
  }

  .track-row:hover,
  .track-row:focus-within {
    transform: none;
    will-change: auto;
  }

  .play-track .app-icon {
    transition: none;
    transform: none;
  }

  .spinner {
    animation: none;
  }
}
</style>
