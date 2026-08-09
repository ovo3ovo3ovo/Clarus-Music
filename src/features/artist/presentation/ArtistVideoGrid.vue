<template>
  <div class="artist-video-grid">
    <article v-for="video in videos" :key="video.id" class="video-card">
      <RouterLink class="video-cover" :to="`/mv/${video.id}`">
        <span class="video-shadow" :style="coverStyle(video.coverUrl)"></span>
        <CoverImage
          :source="video.coverUrl"
          :width="464"
          :height="260"
          role="video-card"
          :alt="video.name"
          loading="lazy"
          decoding="async"
        />
      </RouterLink>
      <RouterLink class="video-title" :to="`/mv/${video.id}`">{{ video.name }}</RouterLink>
      <span class="video-date">{{ video.publishTime }}</span>
    </article>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
import CoverImage from '@/components/common/CoverImage.vue'
import { coverImageUrl } from '@/platform/cover-image'
import type { ArtistVideo } from '../domain/artist'

defineProps<{ videos: readonly ArtistVideo[] }>()

function imageUrl(source: string): string {
  return coverImageUrl(source, 464, 260, { role: 'video-card' })
}

function coverStyle(source: string): Record<'--cover-image', string> {
  return { '--cover-image': `url(${JSON.stringify(imageUrl(source))})` }
}
</script>

<style scoped lang="scss">
.artist-video-grid {
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
  position: relative;
  z-index: 0;
  display: block;
  margin-bottom: 7px;
  aspect-ratio: 16 / 9;

  img {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 6px;
    object-fit: cover;
    transition: transform 200ms ease;
  }
}

.video-shadow {
  position: absolute;
  z-index: 0;
  inset: 7px 8px -7px;
  border-radius: 6px;
  background: center / cover var(--cover-image);
  opacity: 0;
  transform: scale(0.92, 0.96);
  transition: opacity 180ms ease;
}

.video-title,
.video-date {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
}

.video-title {
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 17px;
  overflow-wrap: anywhere;
  opacity: 0.88;
  -webkit-line-clamp: 2;
}

.video-date {
  font-size: 10px;
  line-height: 14px;
  opacity: 0.68;
  -webkit-line-clamp: 1;
}

@media (max-width: 980px) {
  .artist-video-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .video-card,
  .video-cover img,
  .video-shadow {
    transition: none;
  }

  .video-card:hover,
  .video-card:focus-within,
  .video-card:active {
    transform: none;
  }
}
</style>
