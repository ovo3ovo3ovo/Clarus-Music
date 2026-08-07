<template>
  <section class="artist-mv-view" :aria-busy="loading || loadingMore">
    <div v-if="loading" class="center-state" role="status">{{ t('artist.loadingVideos') }}</div>
    <div v-else-if="loadError" class="center-state request-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" @click="loadInitial">{{ t('artist.retry') }}</button>
    </div>
    <template v-else-if="artist">
      <h1>
        <CoverImage
          :source="artist.coverUrl"
          :width="40"
          role="avatar"
          :alt="artist.name"
          decoding="async"
        />
        <span>{{ t('artist.videoTitle', { name: artist.name }) }}</span>
      </h1>
      <ArtistVideoGrid v-if="videos.length" :videos="videos" />
      <div v-else class="center-state">{{ t('artist.noVideos') }}</div>
      <p v-if="loadMoreError" class="load-error" role="alert">{{ loadMoreError }}</p>
      <div v-if="hasMore" class="load-more">
        <button class="flat-action" type="button" :disabled="loadingMore" @click="loadMore">
          {{ t(loadingMore ? 'artist.loadingMore' : 'artist.loadMore') }}
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { parsePositiveIntegerRouteParam } from '@/app/route-params'
import CoverImage from '@/components/common/CoverImage.vue'
import { mergeArtistVideos, type ArtistIdentity, type ArtistVideo } from './domain/artist'
import { NativeArtistGateway } from './infrastructure/native-artist'
import ArtistVideoGrid from './presentation/ArtistVideoGrid.vue'

const route = useRoute()
const { t } = useI18n()
const gateway = new NativeArtistGateway()
const artist = shallowRef<ArtistIdentity | null>(null)
const videos = shallowRef<readonly ArtistVideo[]>([])
const nextOffset = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const loadError = shallowRef<string | null>(null)
const loadMoreError = shallowRef<string | null>(null)
let controller: AbortController | null = null

const artistId = computed(() => parsePositiveIntegerRouteParam(route.params.id))

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

async function loadInitial(): Promise<void> {
  const id = artistId.value
  if (id === null) return
  controller?.abort('Artist video route superseded')
  const current = new AbortController()
  controller = current
  artist.value = null
  videos.value = []
  nextOffset.value = 0
  hasMore.value = false
  loadingMore.value = false
  loading.value = true
  loadError.value = null
  loadMoreError.value = null
  try {
    const [header, page] = await Promise.all([
      gateway.header(id, current.signal),
      gateway.videoPage(id, 0, current.signal),
    ])
    if (controller !== current) return
    artist.value = header
    videos.value = page.items
    nextOffset.value = page.nextOffset
    hasMore.value = page.hasMore
  } catch (reason) {
    if (!isAbort(reason)) {
      loadError.value = message(reason)
      current.abort('Artist video initial load failed')
    }
  } finally {
    if (controller === current) {
      controller = null
      loading.value = false
    }
  }
}

async function loadMore(): Promise<void> {
  const id = artistId.value
  if (id === null || loadingMore.value || !hasMore.value) return
  controller?.abort('Artist video page superseded')
  const current = new AbortController()
  controller = current
  loadingMore.value = true
  loadMoreError.value = null
  try {
    const page = await gateway.videoPage(id, nextOffset.value, current.signal)
    if (controller !== current) return
    videos.value = mergeArtistVideos(videos.value, page)
    nextOffset.value = page.nextOffset
    hasMore.value = page.hasMore
  } catch (reason) {
    if (!isAbort(reason)) loadMoreError.value = message(reason)
  } finally {
    if (controller === current) {
      controller = null
      loadingMore.value = false
    }
  }
}

watch(artistId, () => void loadInitial(), { immediate: true })
onBeforeUnmount(() => controller?.abort('Artist video view disposed'))
</script>

<style scoped lang="scss">
.artist-mv-view {
  min-height: calc(100vh - 160px);
  padding: 34px 0 36px;
  color: var(--color-text);

  h1 {
    display: flex;
    margin: 0 0 28px;
    align-items: center;
    font-size: 28px;
    line-height: 1.15;
    letter-spacing: 0;

    img {
      width: 44px;
      height: 44px;
      margin-right: 12px;
      border: 1px solid rgb(0 0 0 / 5%);
      border-radius: 50%;
      object-fit: cover;
    }

    span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
  }
}

.center-state {
  display: grid;
  min-height: 240px;
  place-items: center;
  opacity: 0.68;
}

.request-error {
  gap: 16px;
  align-content: center;

  button {
    min-height: 36px;
    padding: 0 18px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--color-on-primary);
    background: var(--color-primary);
  }
}

.load-more {
  display: flex;
  padding-top: 30px;
  justify-content: center;
}

.load-error {
  margin: 24px 0 0;
  color: var(--color-danger);
  text-align: center;
}

@media (max-width: 1080px) {
  .artist-mv-view h1 {
    font-size: 28px;
  }
}
</style>
