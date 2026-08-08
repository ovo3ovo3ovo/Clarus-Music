<template>
  <div class="video-grid">
    <article v-for="video in items" :key="video.id" class="video-card">
      <RouterLink class="video-cover" :to="`/mv/${video.id}`">
        <CoverImage
          :source="video.coverUrl"
          :width="464"
          :height="260"
          role="video-card"
          :alt="video.name"
          loading="lazy"
          decoding="async"
          viewport-unload
        />
      </RouterLink>
      <RouterLink class="video-title" :to="`/mv/${video.id}`">{{ video.name }}</RouterLink>
      <RouterLink v-if="video.artistId > 0" class="video-artist" :to="`/artist/${video.artistId}`">
        {{ video.artistName }}
      </RouterLink>
      <span v-else class="video-artist">{{ video.artistName }}</span>
    </article>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
import CoverImage from '@/components/common/CoverImage.vue'
import type { MusicVideoCard } from '../domain/catalog'

defineProps<{ items: readonly MusicVideoCard[] }>()
</script>

<style scoped lang="scss">
.video-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 26px 16px;
}

.video-card {
  position: relative;
  z-index: 0;
  min-width: 0;
  color: var(--color-text);
  content-visibility: auto;
  contain-intrinsic-size: auto 150px;
  transform-origin: center;
  transition: transform var(--motion-hover-emphasis) var(--ease-out);

  &:hover,
  &:focus-within {
    z-index: 2;
    transform: scale(var(--scale-hover-row));
  }

  &:active {
    transform: scale(var(--scale-hover-row));
  }
}

.video-cover {
  display: block;
  margin-bottom: 7px;
  overflow: hidden;
  border-radius: 6px;
  aspect-ratio: 16 / 9;

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 200ms ease;
  }
}

.video-title,
.video-artist {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
}

.video-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 17px;
  opacity: 0.88;
  -webkit-line-clamp: 2;
}

.video-artist {
  font-size: 10px;
  line-height: 14px;
  opacity: 0.68;
  -webkit-line-clamp: 1;
}

@media (prefers-reduced-motion: reduce) {
  .video-card,
  .video-cover img {
    transition: none;
  }

  .video-card:hover,
  .video-card:focus-within,
  .video-card:active {
    transform: none;
  }
}
</style>
