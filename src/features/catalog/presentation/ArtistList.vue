<template>
  <div class="artist-list" role="list">
    <RouterLink
      v-for="(artist, index) in artists"
      :key="artist.id"
      class="artist-row"
      :to="`/artist/${artist.id}`"
      :aria-label="artist.description ? `${artist.name} · ${artist.description}` : artist.name"
      role="listitem"
    >
      <span class="artist-number">{{ index + 1 }}</span>
      <CoverImage
        :source="artist.coverUrl"
        :width="36"
        role="avatar"
        :alt="artist.name"
        loading="lazy"
        decoding="async"
      />
      <span class="artist-copy">
        <strong>{{ artist.name }}</strong>
        <small v-if="artist.description" :title="artist.description">{{
          artist.description
        }}</small>
      </span>
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
import CoverImage from '@/components/common/CoverImage.vue'
import type { ArtistCard } from '@/features/catalog/domain/catalog'

defineProps<{ artists: readonly ArtistCard[] }>()
</script>

<style scoped lang="scss">
.artist-list {
  display: grid;
  width: 100%;
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
