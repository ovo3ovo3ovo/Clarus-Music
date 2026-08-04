<template>
  <section class="typed-search-view" :aria-busy="loading || loadingMore">
    <h1 v-if="searchType">
      <span>{{ t('search.searchFor') }} {{ t(typeLabelKey) }}</span>
      "{{ keywords }}"
    </h1>

    <VirtualTrackList
      v-if="searchType === 'tracks' && tracks.length"
      :tracks="tracks"
      :current-track-id="player.currentTrack?.id ?? null"
      :pending-track-id="player.pendingTrack?.id ?? null"
      :busy-track-id="busyTrackId"
      @play="playTrack"
    />
    <ArtistList v-else-if="searchType === 'artists' && artists.length" :artists="artists" />
    <CatalogCoverGrid v-else-if="searchType === 'albums' && albums.length" :items="albums" />
    <CatalogCoverGrid
      v-else-if="searchType === 'playlists' && playlists.length"
      :items="playlists"
    />
    <MusicVideoGrid
      v-else-if="searchType === 'musicVideos' && musicVideos.length"
      :items="musicVideos"
    />

    <div v-if="loading" class="center-state" role="status" :aria-label="t('search.loading')">
      <AppIcon name="search" />
      <span>{{ t('search.loading') }}</span>
    </div>
    <div v-else-if="!hasItems && !error" class="center-state">
      <AppIcon name="search" />
      <span>{{ t('search.noResult') }}</span>
    </div>

    <div v-if="error" class="request-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="loadPage(result === null)">{{ t('search.retry') }}</button>
    </div>
    <p v-if="playbackError" class="playback-error" role="alert">{{ playbackError }}</p>

    <div v-if="result?.hasMore" class="load-more">
      <button class="flat-action" type="button" :disabled="loadingMore" @click="loadPage(false)">
        <span v-if="loadingMore" class="spinner" aria-hidden="true"></span>
        <AppIcon v-else name="arrow-down" />
        <span>{{ loadingMore ? t('search.loadingMore') : t('search.loadMore') }}</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import { desktop } from '@/platform/desktop'
import { usePlayerStore } from '@/features/player/application/player-store'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import type {
  AlbumCard,
  ArtistCard,
  MusicVideoCard,
  PlaylistCard,
  SearchResultPage,
} from '@/features/catalog/domain/catalog'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import ArtistList from '@/features/catalog/presentation/ArtistList.vue'
import CatalogCoverGrid from '@/features/catalog/presentation/CatalogCoverGrid.vue'
import MusicVideoGrid from '@/features/catalog/presentation/MusicVideoGrid.vue'
import type { Track } from '@/types/music'
import { selectSearchTrack } from './domain/search-playback'
import { appendSearchPage, parseSearchType } from './domain/typed-search'
import VirtualTrackList from './presentation/VirtualTrackList.vue'

const route = useRoute()
const { t } = useI18n()
const gateway = new NativeCatalogGateway()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const result = shallowRef<SearchResultPage | null>(null)
const loading = shallowRef(false)
const loadingMore = shallowRef(false)
const error = shallowRef<string | null>(null)
const playbackError = shallowRef<string | null>(null)
const busyTrackId = shallowRef<number | null>(null)
let requestController: AbortController | null = null
let playbackController: AbortController | null = null

const keywords = computed(() => String(route.params.keywords ?? '').trim())
const searchType = computed(() => parseSearchType(route.params.type))
const typeLabelKey = computed(() => {
  switch (searchType.value) {
    case 'tracks':
      return 'search.song'
    case 'artists':
      return 'search.artist'
    case 'albums':
      return 'search.album'
    case 'playlists':
      return 'search.playlist'
    case 'musicVideos':
      return 'search.mv'
    default:
      return 'nav.search'
  }
})
const tracks = computed<readonly Track[]>(() =>
  result.value?.searchType === 'tracks' ? result.value.items : [],
)
const artists = computed<readonly ArtistCard[]>(() =>
  result.value?.searchType === 'artists' ? result.value.items : [],
)
const albums = computed<readonly AlbumCard[]>(() =>
  result.value?.searchType === 'albums' ? result.value.items : [],
)
const playlists = computed<readonly PlaylistCard[]>(() =>
  result.value?.searchType === 'playlists' ? result.value.items : [],
)
const musicVideos = computed<readonly MusicVideoCard[]>(() =>
  result.value?.searchType === 'musicVideos' ? result.value.items : [],
)
const hasItems = computed(() => (result.value?.items.length ?? 0) > 0)

function message(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue)
}

async function loadPage(reset: boolean): Promise<void> {
  const type = searchType.value
  const nextKeywords = keywords.value
  if (!type || nextKeywords.length === 0 || !desktop.isDesktop) {
    loading.value = false
    loadingMore.value = false
    return
  }
  if (!reset && (!result.value?.hasMore || loadingMore.value)) return

  requestController?.abort('Search page request superseded')
  const controller = new AbortController()
  requestController = controller
  if (reset) {
    result.value = null
    loading.value = true
    playbackController?.abort('Search changed')
    playbackController = null
    busyTrackId.value = null
    playbackError.value = null
  } else {
    loadingMore.value = true
  }
  error.value = null

  try {
    const page = await gateway.searchPage(
      type,
      nextKeywords,
      reset ? 0 : (result.value?.nextOffset ?? 0),
      controller.signal,
    )
    if (requestController !== controller) return
    result.value = reset ? page : appendSearchPage(result.value, page)
  } catch (reason) {
    if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
      error.value = message(reason)
    }
  } finally {
    if (requestController === controller) {
      requestController = null
      loading.value = false
      loadingMore.value = false
    }
  }
}

async function playTrack(track: Track): Promise<void> {
  if (!track.playable || !desktop.isDesktop) return
  const selection = selectSearchTrack(tracks.value, track.id)
  if (!selection) return

  playbackController?.abort('Track selection superseded')
  const controller = new AbortController()
  playbackController = controller
  busyTrackId.value = track.id
  playbackError.value = null
  try {
    const source = await gateway.resolveStream(
      track.id,
      settingsStore.settings.musicQuality,
      controller.signal,
    )
    if (playbackController !== controller) return
    player.setQueue(selection.queue, selection.index)
    await player.load(selection.track, source, true, controller.signal)
  } catch (reason) {
    if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
      playbackError.value = message(reason)
    }
  } finally {
    if (playbackController === controller) {
      playbackController = null
      busyTrackId.value = null
    }
  }
}

watch([keywords, searchType], () => void loadPage(true), { immediate: true })

onBeforeUnmount(() => {
  requestController?.abort('Typed search view disposed')
  playbackController?.abort('Typed search view disposed')
})
</script>

<style scoped lang="scss">
.typed-search-view {
  min-height: calc(100vh - 160px);
}

h1 {
  margin: 0 0 22px;
  color: var(--color-text);
  font-size: 28px;
  letter-spacing: -0.045em;

  span {
    opacity: 0.58;
  }
}

.center-state {
  display: flex;
  min-height: 320px;
  align-items: center;
  justify-content: center;
  color: var(--color-text);
  font-size: 18px;
  opacity: 0.38;

  .app-icon {
    width: 24px;
    height: 24px;
    margin-right: 16px;
  }
}

.request-error,
.playback-error {
  color: var(--color-danger);
}

.request-error {
  display: flex;
  margin-top: 24px;
  align-items: center;
  justify-content: center;
  gap: 12px;

  button {
    min-height: 34px;
    padding: 6px 12px;
    border: 1px solid currentColor;
    border-radius: 8px;
    color: inherit;
    background: transparent;
  }
}

.playback-error {
  margin: 16px 0 0;
  text-align: center;
}

.load-more {
  display: flex;
  margin-top: 32px;
  justify-content: center;

  .app-icon,
  .spinner {
    width: 15px;
    height: 15px;
  }
}

.spinner {
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 600ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}
</style>
