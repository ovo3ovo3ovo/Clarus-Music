<template>
  <div class="playlist-grid" role="list">
    <article v-for="playlist in items" :key="playlist.id" class="playlist-card" role="listitem">
      <RouterLink class="cover-link" :to="`/playlist/${playlist.id}`" :aria-label="playlist.name">
        <CoverImage
          :source="playlist.coverUrl"
          :width="128"
          :alt="playlist.name"
          loading="lazy"
          decoding="async"
        />
      </RouterLink>

      <div class="playlist-copy">
        <RouterLink class="title" :to="`/playlist/${playlist.id}`" :title="playlist.name">
          {{ playlist.name }}
        </RouterLink>
        <span v-if="mobileMeta(playlist)" class="mobile-meta" :title="mobileMeta(playlist)">
          {{ mobileMeta(playlist) }}
        </span>
      </div>

      <span class="creator" :title="playlist.creatorName">{{ playlist.creatorName }}</span>
      <span class="track-count">{{ trackCount(playlist) }}</span>
      <button
        class="play-button"
        type="button"
        :title="t('playlist.play')"
        :aria-label="t('playlist.play')"
        :disabled="busyPlaylistId !== null"
        @click="emit('play', playlist)"
      >
        <span v-if="busyPlaylistId === playlist.id" class="spinner" aria-hidden="true"></span>
        <AppIcon v-else name="play" />
      </button>
    </article>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import type { LibraryPlaylist } from '../domain/library'

defineProps<{
  items: readonly LibraryPlaylist[]
  busyPlaylistId: number | null
}>()

const emit = defineEmits<{ play: [playlist: LibraryPlaylist] }>()
const { t, locale } = useI18n()

function trackCount(playlist: LibraryPlaylist): string {
  return `${new Intl.NumberFormat(locale.value).format(playlist.trackCount)} ${t('playlist.songs')}`
}

function mobileMeta(playlist: LibraryPlaylist): string {
  return [playlist.creatorName, trackCount(playlist)].filter(Boolean).join(' · ')
}
</script>

<style scoped lang="scss">
.playlist-grid {
  display: grid;
  width: 100%;
}

.playlist-card {
  display: grid;
  position: relative;
  z-index: 0;
  min-width: 0;
  min-height: 54px;
  padding: 5px 4px;
  border-radius: 5px;
  grid-template-columns: 40px minmax(0, 1.4fr) minmax(132px, 0.74fr) minmax(76px, 0.36fr) 32px;
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

  &:active {
    transform: scale(var(--scale-hover-row));
  }
}

.cover-link {
  display: block;
  width: 40px;
  height: 40px;

  img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 4px;
    object-fit: cover;
  }

  &:focus-visible img {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
}

.playlist-copy {
  display: flex;
  min-width: 0;
  padding: 0 10px;
  flex-direction: column;
  gap: 1px;
}

.title,
.creator,
.track-count,
.mobile-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title {
  color: var(--color-text);
  font-size: 13px;
  font-weight: var(--font-weight-regular);
  letter-spacing: -0.012em;
  line-height: 17px;

  &:focus-visible {
    outline: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
}

.creator,
.track-count,
.mobile-meta {
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 15px;
  opacity: 0.7;
}

.creator {
  min-width: 0;
  padding: 0 10px;
}

.track-count {
  padding: 0 8px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.play-button {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 7px;
  border: 0;
  border-radius: 4px;
  place-items: center;
  color: var(--color-text-secondary);
  background: transparent;
  opacity: 0;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease;

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
    color: var(--color-text);
    background: transparent;
    opacity: 1;

    .app-icon {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:focus-visible:not(:disabled):not(:hover) {
    color: var(--color-text);
    background: transparent;
    opacity: 1;

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
    opacity: 0.38;
  }
}

.playlist-card:hover .play-button,
.playlist-card:focus-within .play-button {
  opacity: 0.72;
}

.mobile-meta {
  display: none;
}

.spinner {
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .playlist-card {
    grid-template-columns: 40px minmax(0, 1fr) 32px;
  }

  .creator,
  .track-count {
    display: none;
  }

  .mobile-meta {
    display: block;
  }

  .play-button {
    opacity: 0.68;
  }
}

@media (prefers-reduced-motion: reduce) {
  .playlist-card,
  .play-button,
  .spinner {
    transition: none;
    animation: none;
  }

  .playlist-card:hover,
  .playlist-card:focus-within,
  .playlist-card:active,
  .play-button:hover:not(:disabled),
  .play-button:focus-visible:not(:disabled),
  .play-button:active:not(:disabled) {
    transform: none;
    will-change: auto;
  }

  .play-button .app-icon {
    transition: none;
    transform: none;
  }
}
</style>
