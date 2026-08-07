<template>
  <div
    :ref="virtualRows.listRoot"
    class="artist-list"
    :class="{ 'is-virtualized': isVirtualized }"
    :style="listStyle"
    role="list"
  >
    <RouterLink
      v-for="row in renderedRows"
      :key="String(row.key)"
      class="artist-row"
      :class="{ 'is-virtual-row': isVirtualized }"
      :style="rowStyle(row)"
      :to="`/artist/${row.item.id}`"
      :aria-label="
        row.item.description ? `${row.item.name} · ${row.item.description}` : row.item.name
      "
      role="listitem"
    >
      <span class="artist-number">{{ row.index + 1 }}</span>
      <CoverImage
        :source="row.item.coverUrl"
        :width="36"
        role="avatar"
        :alt="row.item.name"
        loading="lazy"
        decoding="async"
        viewport-unload
      />
      <span class="artist-copy">
        <strong>{{ row.item.name }}</strong>
        <small v-if="row.item.description" :title="row.item.description">{{
          row.item.description
        }}</small>
      </span>
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import CoverImage from '@/components/common/CoverImage.vue'
import {
  useFixedRowVirtualizer,
  type FixedVirtualRow,
} from '@/components/common/use-fixed-row-virtualizer'
import type { ArtistCard } from '@/features/catalog/domain/catalog'

const props = defineProps<{ artists: readonly ArtistCard[] }>()
const virtualRows = useFixedRowVirtualizer(
  computed(() => props.artists),
  {
    rowHeight: 46,
    getItemKey: (artist) => artist.id,
  },
)
const { isVirtualized, listStyle, rowStyle } = virtualRows
const renderedRows = computed<readonly (FixedVirtualRow & { readonly item: ArtistCard })[]>(() =>
  virtualRows.visibleRows.value.flatMap((row) => {
    const item = props.artists[row.index]
    return item === undefined ? [] : [{ ...row, item }]
  }),
)
</script>

<style scoped lang="scss">
.artist-list {
  display: grid;
  width: 100%;

  &.is-virtualized {
    position: relative;
    display: block;
    contain: layout style;
  }
}

.artist-row {
  display: grid;
  position: relative;
  z-index: 0;
  min-width: 0;
  min-height: 46px;
  padding: 4px;
  border-radius: 7px;
  grid-template-columns: 28px 36px minmax(0, 1fr);
  align-items: center;
  color: var(--color-text);
  background: transparent;
  content-visibility: auto;
  contain-intrinsic-size: 46px;
  transition:
    color var(--motion-fast) ease,
    transform var(--motion-hover-emphasis) var(--ease-out);
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

  &:focus-visible:not(:hover) {
    background: transparent;
    transform: none;
    z-index: 1;
  }

  &:active {
    transform: scale(var(--scale-hover-row));
  }

  &.is-virtual-row:hover,
  &.is-virtual-row:focus-visible,
  &.is-virtual-row:active {
    transform: translate3d(0, var(--virtual-row-y), 0);
  }

  img {
    display: block;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    object-fit: cover;
  }
}

.artist-number {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.58;
  text-align: center;
}

.artist-copy {
  display: flex;
  min-width: 0;
  padding: 0 10px;
  flex-direction: column;
  gap: 1px;

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    color: var(--color-text);
    font-size: 13px;
    font-weight: var(--font-weight-regular);
    letter-spacing: -0.012em;
    line-height: 16px;
  }

  small {
    color: var(--color-text-secondary);
    font-size: 11px;
    line-height: 14px;
    opacity: 0.68;
  }
}

@media (prefers-reduced-motion: reduce) {
  .artist-row {
    transition: none;

    &:hover,
    &:focus-visible,
    &:active {
      transform: none;
      will-change: auto;
    }
  }
}
</style>
