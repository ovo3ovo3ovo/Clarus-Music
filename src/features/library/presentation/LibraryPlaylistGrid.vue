<template>
  <div
    :ref="virtualRows.listRoot"
    class="playlist-grid"
    :class="{ 'is-virtualized': isVirtualized }"
    :style="listStyle"
    role="list"
  >
    <article
      v-for="row in renderedRows"
      :key="String(row.key)"
      class="playlist-card"
      :class="{ 'is-virtual-row': isVirtualized }"
      :style="rowStyle(row)"
      role="listitem"
    >
      <RouterLink class="cover-link" :to="`/playlist/${row.item.id}`" :aria-label="row.item.name">
        <CoverImage
          :source="row.item.coverUrl"
          :width="40"
          role="row"
          :alt="row.item.name"
          loading="lazy"
          decoding="async"
        />
      </RouterLink>

      <div class="playlist-copy">
        <RouterLink class="title" :to="`/playlist/${row.item.id}`" :title="row.item.name">
          {{ row.item.name }}
        </RouterLink>
        <span v-if="mobileMeta(row.item)" class="mobile-meta" :title="mobileMeta(row.item)">
          {{ mobileMeta(row.item) }}
        </span>
      </div>

      <span class="creator" :title="row.item.creatorName">{{ row.item.creatorName }}</span>
      <span class="track-count">{{ trackCount(row.item) }}</span>
      <button
        class="play-button"
        type="button"
        :title="t('playlist.play')"
        :aria-label="t('playlist.play')"
        :disabled="busyPlaylistId !== null"
        @click="emit('play', row.item)"
      >
        <span v-if="busyPlaylistId === row.item.id" class="spinner" aria-hidden="true"></span>
        <AppIcon v-else name="play" />
      </button>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import {
  useFixedRowVirtualizer,
  type FixedVirtualRow,
} from '@/components/common/use-fixed-row-virtualizer'
import type { LibraryPlaylist } from '../domain/library'

const props = defineProps<{
  items: readonly LibraryPlaylist[]
  busyPlaylistId: number | null
}>()

const emit = defineEmits<{ play: [playlist: LibraryPlaylist] }>()
const { t, locale } = useI18n()
const virtualRows = useFixedRowVirtualizer(
  computed(() => props.items),
  {
    rowHeight: 54,
    // Playlist cards contain artwork. Preserve their DOM identity so a
    // scroll does not turn every card into a new image request/decode.
    virtualizeAt: Number.POSITIVE_INFINITY,
    getItemKey: (playlist) => playlist.id,
  },
)
const { isVirtualized, listStyle, rowStyle } = virtualRows
const renderedRows = computed<readonly (FixedVirtualRow & { readonly item: LibraryPlaylist })[]>(
  () =>
    virtualRows.visibleRows.value.flatMap((row) => {
      const item = props.items[row.index]
      return item === undefined ? [] : [{ ...row, item }]
    }),
)

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

  &.is-virtualized {
    position: relative;
    display: block;
    contain: layout style;
  }
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
  // Keep playlist artwork in normal flow so it is not decoded again after a
  // scroll suspension in WKWebView.
  transition: transform var(--motion-hover-emphasis) var(--ease-out);
  transform-origin: center;

  &.is-virtual-row {
    position: absolute;
    top: var(--virtual-row-y);
    left: 0;
    width: 100%;
    transform: none;
    transition: none;
  }

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

  &.is-virtual-row:hover,
  &.is-virtual-row:focus-within,
  &.is-virtual-row:active {
    transform: none;
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
