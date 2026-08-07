<template>
  <div
    :ref="virtualRows.listRoot"
    class="artist-album-grid"
    :class="{ 'is-virtualized': isVirtualized }"
    :style="listStyle"
    role="list"
  >
    <article
      v-for="row in renderedRows"
      :key="String(row.key)"
      class="album-card"
      :class="{ 'is-virtual-row': isVirtualized }"
      :style="rowStyle(row)"
      role="listitem"
    >
      <RouterLink class="cover-link" :to="`/album/${row.item.id}`" :aria-label="row.item.name">
        <CoverImage
          :source="row.item.coverUrl"
          :width="40"
          role="row"
          :alt="row.item.name"
          loading="lazy"
          decoding="async"
          viewport-unload
        />
      </RouterLink>

      <div class="album-copy">
        <RouterLink class="album-title" :to="`/album/${row.item.id}`" :title="row.item.name">
          <span>{{ row.item.name }}</span>
          <AppIcon v-if="row.item.explicit" class="explicit" name="explicit" />
        </RouterLink>
        <span class="mobile-meta">{{ mobileMeta(row.item) }}</span>
      </div>

      <span class="album-subtitle">{{ subtitle(row.item) }}</span>
      <span class="album-count">{{ trackCount(row.item) }}</span>
      <button
        class="play-album"
        type="button"
        :title="t('artist.playAlbum')"
        :aria-label="t('artist.playAlbum')"
        :disabled="busyAlbumId !== null"
        @click="emit('play', row.item)"
      >
        <span v-if="busyAlbumId === row.item.id" class="spinner" aria-hidden="true"></span>
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
import { formatArtistAlbumType, type ArtistAlbum } from '../domain/artist'

const props = withDefaults(
  defineProps<{
    albums: readonly ArtistAlbum[]
    busyAlbumId: number | null
    subtitleMode?: 'releaseYear' | 'albumTypeReleaseYear'
  }>(),
  { subtitleMode: 'releaseYear' },
)
const emit = defineEmits<{ play: [album: ArtistAlbum] }>()
const { t, locale } = useI18n()
const virtualRows = useFixedRowVirtualizer(
  computed(() => props.albums),
  {
    rowHeight: 54,
    getItemKey: (album) => album.id,
  },
)
const { isVirtualized, listStyle, rowStyle } = virtualRows
const renderedRows = computed<readonly (FixedVirtualRow & { readonly item: ArtistAlbum })[]>(() =>
  virtualRows.visibleRows.value.flatMap((row) => {
    const item = props.albums[row.index]
    return item === undefined ? [] : [{ ...row, item }]
  }),
)

function subtitle(album: ArtistAlbum): string {
  const year = new Date(album.publishTime).getFullYear()
  return props.subtitleMode === 'releaseYear'
    ? String(year)
    : `${formatArtistAlbumType(album)} · ${year}`
}

function trackCount(album: ArtistAlbum): string {
  return `${new Intl.NumberFormat(locale.value).format(album.trackCount)} ${t('album.songs')}`
}

function mobileMeta(album: ArtistAlbum): string {
  return `${subtitle(album)} · ${trackCount(album)}`
}
</script>

<style scoped lang="scss">
.artist-album-grid {
  display: grid;
  width: 100%;

  &.is-virtualized {
    position: relative;
    display: block;
    contain: layout style;
  }
}

.album-card {
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

  &.is-virtual-row {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    transform: translate3d(0, var(--virtual-row-y), 0);
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
    transform: translate3d(0, var(--virtual-row-y), 0);
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

.album-copy {
  display: flex;
  min-width: 0;
  padding: 0 10px;
  flex-direction: column;
  gap: 1px;
}

.album-title,
.album-subtitle,
.album-count,
.mobile-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.album-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  color: var(--color-text);
  font-size: 13px;
  font-weight: var(--font-weight-regular);
  letter-spacing: -0.012em;
  line-height: 17px;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:focus-visible {
    outline: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
}

.album-subtitle,
.album-count,
.mobile-meta {
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 15px;
  opacity: 0.7;
}

.album-subtitle {
  min-width: 0;
  padding: 0 10px;
}

.album-count {
  padding: 0 8px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.explicit {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  opacity: 0.42;
}

.play-album {
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
  transform-origin: center;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease,
    transform var(--motion-hover-emphasis) var(--ease-out);

  .app-icon,
  .spinner {
    width: 14px;
    height: 14px;
  }

  &:hover:not(:disabled) {
    color: var(--color-text);
    background: transparent;
    opacity: 1;
    transform: scale(var(--scale-hover-icon));
  }

  &:focus-visible:not(:disabled):not(:hover) {
    color: var(--color-text);
    background: transparent;
    opacity: 1;
    transform: none;
  }

  &:active:not(:disabled) {
    transform: scale(var(--scale-hover-icon));
  }

  &:disabled {
    opacity: 0.38;
  }
}

.album-card:hover .play-album,
.album-card:focus-within .play-album {
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
  .album-card {
    grid-template-columns: 40px minmax(0, 1fr) 32px;
  }

  .album-subtitle,
  .album-count {
    display: none;
  }

  .mobile-meta {
    display: block;
  }

  .play-album {
    opacity: 0.68;
  }
}

@media (prefers-reduced-motion: reduce) {
  .album-card,
  .play-album,
  .spinner {
    transition: none;
    animation: none;
  }

  .album-card:hover,
  .album-card:focus-within,
  .album-card:active,
  .play-album:hover:not(:disabled),
  .play-album:focus-visible:not(:disabled),
  .play-album:active:not(:disabled) {
    transform: none;
    will-change: auto;
  }
}
</style>
