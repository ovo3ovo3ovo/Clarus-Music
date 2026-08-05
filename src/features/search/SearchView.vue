<template>
  <section class="search-view" :aria-busy="loading">
    <h1 class="search-title">
      {{ t('nav.search') }}<span v-if="keywords"> · {{ keywords }}</span>
    </h1>
    <div v-if="showTopRow" class="top-row">
      <section v-if="overview?.artists.items.length || overview?.artists.error" class="artists">
        <SearchSectionHeading :title="t('search.artist')" :to="typedSearchRoute('artists')" />
        <ArtistList v-if="overview.artists.items.length" :artists="overview.artists.items" />
        <p v-else class="section-error">{{ overview.artists.error }}</p>
      </section>

      <section v-if="overview?.albums.items.length || overview?.albums.error" class="albums">
        <SearchSectionHeading :title="t('search.album')" :to="typedSearchRoute('albums')" />
        <CatalogCoverGrid v-if="overview.albums.items.length" :items="overview.albums.items" />
        <p v-else class="section-error">{{ overview.albums.error }}</p>
      </section>
    </div>

    <section v-if="overview?.tracks.items.length || overview?.tracks.error" class="result-section">
      <SearchSectionHeading :title="t('search.song')" :to="typedSearchRoute('tracks')" />
      <TrackGrid
        v-if="overview.tracks.items.length"
        :tracks="overview.tracks.items"
        :current-track-id="player.currentTrack?.id ?? null"
        :pending-track-id="player.pendingTrack?.id ?? null"
        :busy-track-id="busyTrackId"
        @play="playTrack"
      />
      <p v-else class="section-error">{{ overview.tracks.error }}</p>
      <p v-if="playbackError" class="section-error playback-error">{{ playbackError }}</p>
    </section>

    <section
      v-if="overview?.musicVideos.items.length || overview?.musicVideos.error"
      class="result-section"
    >
      <SearchSectionHeading :title="t('search.mv')" :to="typedSearchRoute('musicVideos')" />
      <MusicVideoGrid
        v-if="overview.musicVideos.items.length"
        :items="overview.musicVideos.items"
      />
      <p v-else class="section-error">{{ overview.musicVideos.error }}</p>
    </section>

    <section
      v-if="overview?.playlists.items.length || overview?.playlists.error"
      class="result-section"
    >
      <SearchSectionHeading :title="t('search.playlist')" :to="typedSearchRoute('playlists')" />
      <CatalogCoverGrid v-if="overview.playlists.items.length" :items="overview.playlists.items" />
      <p v-else class="section-error">{{ overview.playlists.error }}</p>
    </section>

    <div v-if="loading" class="center-state" role="status" :aria-label="t('search.loading')">
      <AppIcon name="search" />
    </div>
    <div v-else-if="showEmptyState" class="center-state">
      <AppIcon name="search" />
      <span>{{ keywords.length === 0 ? t('search.emptyKeyword') : t('search.noResult') }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { useRoute, type RouteLocationRaw } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import { desktop } from '@/platform/desktop'
import { usePlayerStore } from '@/features/player/application/player-store'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import type { SearchOverview, SearchType } from '@/features/catalog/domain/catalog'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import { releaseAudioSource } from '@/features/player/domain/audio-engine'
import ArtistList from '@/features/catalog/presentation/ArtistList.vue'
import CatalogCoverGrid from '@/features/catalog/presentation/CatalogCoverGrid.vue'
import MusicVideoGrid from '@/features/catalog/presentation/MusicVideoGrid.vue'
import TrackGrid from '@/features/catalog/presentation/TrackGrid.vue'
import type { Track } from '@/types/music'
import { selectSearchTrack } from './domain/search-playback'
import { searchTypeRouteSegment } from './domain/typed-search'
import SearchSectionHeading from './presentation/SearchSectionHeading.vue'

const route = useRoute()
const { t } = useI18n()
const gateway = new NativeCatalogGateway()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const overview = shallowRef<SearchOverview | null>(null)
const loading = shallowRef(false)
const busyTrackId = shallowRef<number | null>(null)
const playbackError = shallowRef<string | null>(null)
let searchController: AbortController | null = null
let playbackController: AbortController | null = null

const keywords = computed(() => String(route.params.keywords ?? '').trim())
const showTopRow = computed(
  () =>
    Boolean(overview.value?.artists.items.length) ||
    Boolean(overview.value?.artists.error) ||
    Boolean(overview.value?.albums.items.length) ||
    Boolean(overview.value?.albums.error),
)
const hasItems = computed(() => {
  const result = overview.value
  if (!result) return false
  return (
    result.tracks.items.length +
      result.artists.items.length +
      result.albums.items.length +
      result.playlists.items.length +
      result.musicVideos.items.length >
    0
  )
})
const hasSectionError = computed(() => {
  const result = overview.value
  return Boolean(
    result?.tracks.error ||
    result?.artists.error ||
    result?.albums.error ||
    result?.playlists.error ||
    result?.musicVideos.error,
  )
})
const showEmptyState = computed(
  () => keywords.value.length === 0 || (!hasItems.value && !hasSectionError.value),
)

function typedSearchRoute(type: SearchType): RouteLocationRaw {
  return {
    name: 'searchType',
    params: { keywords: keywords.value, type: searchTypeRouteSegment(type) },
  }
}

function failedOverview(error: unknown): SearchOverview {
  const message = error instanceof Error ? error.message : String(error)
  const section = { items: [], total: 0, error: message } as const
  return {
    tracks: section,
    artists: section,
    albums: section,
    playlists: section,
    musicVideos: section,
  }
}

async function search(nextKeywords: string): Promise<void> {
  searchController?.abort('Search superseded')
  searchController = null
  playbackController?.abort('Search changed')
  playbackController = null
  busyTrackId.value = null
  playbackError.value = null
  overview.value = null

  if (nextKeywords.length === 0 || !desktop.isDesktop) {
    loading.value = false
    return
  }

  const controller = new AbortController()
  searchController = controller
  loading.value = true
  try {
    overview.value = await gateway.searchOverview(nextKeywords, controller.signal)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      overview.value = failedOverview(error)
    }
  } finally {
    if (searchController === controller) {
      searchController = null
      loading.value = false
    }
  }
}

async function playTrack(track: Track): Promise<void> {
  if (!overview.value || !track.playable || !desktop.isDesktop) return
  const selection = selectSearchTrack(overview.value.tracks.items, track.id)
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
    if (playbackController !== controller) {
      releaseAudioSource(source)
      return
    }
    player.setQueue(selection.queue, selection.index)
    await player.load(selection.track, source, true, controller.signal)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      playbackError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (playbackController === controller) {
      playbackController = null
      busyTrackId.value = null
    }
  }
}

watch(keywords, (value) => void search(value), { immediate: true })

onBeforeUnmount(() => {
  searchController?.abort('Search view disposed')
  playbackController?.abort('Search view disposed')
})
</script>

<style scoped lang="scss">
.search-view {
  min-height: calc(100vh - 160px);
}

.search-title {
  margin: 0 0 22px;
  font-size: 28px;
  letter-spacing: -0.045em;

  span {
    color: var(--color-text-secondary);
    font-weight: 500;
  }
}

.top-row {
  display: flex;
  flex-wrap: wrap;

  .artists,
  .albums {
    min-width: 0;
    flex: 1;
  }
}

.result-section {
  margin-top: 32px;
}

.section-error {
  min-height: 64px;
  margin: 0;
  color: var(--color-text);
  opacity: 0.58;
}

.playback-error {
  min-height: 0;
  margin-top: 10px;
  color: var(--color-danger);
  opacity: 1;
}

.center-state {
  position: absolute;
  inset: 64px 0;
  display: flex;
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

[aria-busy='true'] .center-state .app-icon {
  animation: pulse 900ms ease-in-out infinite alternate;
}

@keyframes pulse {
  to {
    opacity: 0.3;
    transform: scale(0.92);
  }
}

@media (prefers-reduced-motion: reduce) {
  [aria-busy='true'] .center-state .app-icon {
    animation: none;
  }
}
</style>
