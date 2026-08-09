<template>
  <div class="catalog-cover-grid" role="list">
    <article
      v-for="item in items"
      :key="`${item.kind}-${item.id}`"
      class="cover-card"
      role="listitem"
    >
      <RouterLink class="cover-link" :to="`/${item.kind}/${item.id}`" :aria-label="item.name">
        <CoverImage
          :source="item.coverUrl"
          :width="40"
          role="row"
          :alt="item.name"
          loading="lazy"
          decoding="async"
        />
      </RouterLink>

      <div class="cover-copy">
        <RouterLink class="title" :to="`/${item.kind}/${item.id}`" :title="item.name">
          {{ item.name }}
        </RouterLink>
        <span v-if="mobileContext(item)" class="mobile-context" :title="mobileContext(item)">
          {{ mobileContext(item) }}
        </span>
      </div>

      <RouterLink
        v-if="item.kind === 'album'"
        class="item-context"
        :to="`/artist/${item.artistId}`"
        :title="item.artistName"
      >
        {{ item.artistName }}
      </RouterLink>
      <span v-else class="item-context" :title="context(item)">{{ context(item) }}</span>
      <span class="item-metric" :class="{ empty: !metric(item) }">{{ metric(item) }}</span>
    </article>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import CoverImage from '@/components/common/CoverImage.vue'
import type { CatalogCoverCard } from '../domain/catalog'

defineProps<{ items: readonly CatalogCoverCard[] }>()

const { t, locale } = useI18n()

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
