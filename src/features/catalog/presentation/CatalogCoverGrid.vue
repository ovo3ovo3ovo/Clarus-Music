<template>
  <div
    :ref="virtualRows.listRoot"
    class="catalog-cover-grid"
    :class="{ 'is-virtualized': isVirtualized }"
    :style="listStyle"
    role="list"
  >
    <article
      v-for="row in renderedRows"
      :key="String(row.key)"
      class="cover-card"
      :class="{ 'is-virtual-row': isVirtualized }"
      :style="rowStyle(row)"
      role="listitem"
    >
      <RouterLink
        class="cover-link"
        :to="`/${row.item.kind}/${row.item.id}`"
        :aria-label="row.item.name"
      >
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

      <div class="cover-copy">
        <RouterLink class="title" :to="`/${row.item.kind}/${row.item.id}`" :title="row.item.name">
          {{ row.item.name }}
        </RouterLink>
        <span
          v-if="mobileContext(row.item)"
          class="mobile-context"
          :title="mobileContext(row.item)"
        >
          {{ mobileContext(row.item) }}
        </span>
      </div>

      <RouterLink
        v-if="row.item.kind === 'album'"
        class="item-context"
        :to="`/artist/${row.item.artistId}`"
        :title="row.item.artistName"
      >
        {{ row.item.artistName }}
      </RouterLink>
      <span v-else class="item-context" :title="context(row.item)">{{ context(row.item) }}</span>
      <span class="item-metric" :class="{ empty: !metric(row.item) }">{{ metric(row.item) }}</span>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import CoverImage from '@/components/common/CoverImage.vue'
import {
  useFixedRowVirtualizer,
  type FixedVirtualRow,
} from '@/components/common/use-fixed-row-virtualizer'
import type { CatalogCoverCard } from '../domain/catalog'

const props = defineProps<{ items: readonly CatalogCoverCard[] }>()

const { t, locale } = useI18n()
const virtualRows = useFixedRowVirtualizer(
  computed(() => props.items),
  {
    rowHeight: 54,
    getItemKey: (item) => `${item.kind}-${item.id}`,
  },
)
const { isVirtualized, listStyle, rowStyle } = virtualRows
const renderedRows = computed<readonly (FixedVirtualRow & { readonly item: CatalogCoverCard })[]>(
  () =>
    virtualRows.visibleRows.value.flatMap((row) => {
      const item = props.items[row.index]
      return item === undefined ? [] : [{ ...row, item }]
    }),
)

function context(item: CatalogCoverCard): string {
  if (item.kind === 'playlist') return item.creatorName
  if (item.kind === 'artist') return item.description
  return item.artistName
}

function metric(item: CatalogCoverCard): string {
  if (item.kind !== 'playlist') return ''
  return `${new Intl.NumberFormat(locale.value).format(item.trackCount)} ${t('playlist.songs')}`
}

function mobileContext(item: CatalogCoverCard): string {
  return [context(item), metric(item)].filter(Boolean).join(' · ')
}
</script>

<style scoped lang="scss">
.catalog-cover-grid {
  display: grid;
  width: 100%;

  &.is-virtualized {
    position: relative;
    display: block;
    contain: layout style;
  }
}

.cover-card {
  display: grid;
  position: relative;
  z-index: 0;
  min-width: 0;
  min-height: 54px;
  padding: 5px 4px;
  border-radius: 5px;
  grid-template-columns: 40px minmax(0, 1.4fr) minmax(132px, 0.74fr) minmax(76px, 0.36fr);
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

.cover-copy {
  display: flex;
  min-width: 0;
  padding: 0 10px;
  flex-direction: column;
  gap: 1px;
}

.title,
.item-context,
.item-metric,
.mobile-context {
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

.item-context,
.item-metric,
.mobile-context {
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 15px;
  opacity: 0.7;
}

.item-context {
  min-width: 0;
  padding: 0 10px;

  &:is(a):hover,
  &:is(a):focus-visible {
    color: var(--color-text);
    opacity: 1;
  }
}

.item-metric {
  padding: 0 8px;
  font-variant-numeric: tabular-nums;
  text-align: right;

  &.empty {
    visibility: hidden;
  }
}

.mobile-context {
  display: none;
}

@media (max-width: 720px) {
  .cover-card {
    grid-template-columns: 40px minmax(0, 1fr);
  }

  .item-context,
  .item-metric {
    display: none;
  }

  .mobile-context {
    display: block;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cover-card {
    transition: none;

    &:hover,
    &:focus-within,
    &:active {
      transform: none;
      will-change: auto;
    }
  }
}
</style>
