<template>
  <section class="library-view" :aria-busy="pageBusy">
    <ContentLoadingVeil
      v-if="authStore.restoring || (overviewLoading && !overview)"
      :label="t('library.loading')"
    />

    <div v-else-if="overviewError && !overview" class="center-state request-error" role="alert">
      <span>{{ overviewError }}</span>
      <button type="button" @click="loadOverview">{{ t('library.retry') }}</button>
    </div>

    <template v-else-if="overview && user">
      <header class="library-page-header">
        <h1>{{ pageTitle }}</h1>
        <button
          v-if="currentTab === 'playlists' && playlistFilter === 'mine'"
          class="tab-action"
          type="button"
          @click="createDialogOpen = true"
        >
          <AppIcon name="plus" />
          <span>{{ t('library.newPlaylist') }}</span>
        </button>
      </header>

      <p v-if="operationError" class="operation-error" role="alert">{{ operationError }}</p>

      <section class="library-sections">
        <div v-if="currentTab === 'playlists'" class="section-panel">
          <LibraryPlaylistGrid
            v-if="filteredPlaylists.length"
            :items="filteredPlaylists"
            :busy-playlist-id="busyPlaylistId"
            @play="playPlaylistCard"
          />
          <LibraryEmptyState
            v-else-if="!playlistLoading"
            icon="list"
            :title="playlistEmptyState.title"
            :description="playlistEmptyState.description"
          />
          <SectionState
            :loading="playlistLoading"
            :error="playlistError"
            :has-more="playlistHasMore"
            @retry="loadMorePlaylists"
            @load-more="loadMorePlaylists"
          />
        </div>

        <div v-else-if="currentTab === 'albums'" class="section-panel">
          <CatalogCoverGrid v-if="albums.length" :items="albums" />
          <LibraryEmptyState
            v-else-if="!catalogLoading.albums"
            icon="album"
            :title="t('library.emptySavedAlbums')"
            :description="t('library.emptySavedAlbumsHint')"
          />
          <SectionState
            :loading="catalogLoading.albums"
            :error="catalogErrors.albums"
            :has-more="catalogHasMore.albums"
            @retry="loadCatalog('albums', catalogLoaded.albums)"
            @load-more="loadCatalog('albums', true)"
          />
        </div>

        <div v-else-if="currentTab === 'artists'" class="section-panel">
          <ArtistList v-if="artists.length" :artists="artists" />
          <LibraryEmptyState
            v-else-if="!catalogLoading.artists"
            icon="artist"
            :title="t('library.emptyArtists')"
            :description="t('library.emptyArtistsHint')"
          />
          <SectionState
            :loading="catalogLoading.artists"
            :error="catalogErrors.artists"
            :has-more="catalogHasMore.artists"
            @retry="loadCatalog('artists', catalogLoaded.artists)"
            @load-more="loadCatalog('artists', true)"
          />
        </div>

        <div v-else class="section-panel history-panel">
          <div class="history-periods">
            <button
              type="button"
              :class="{ active: historyPeriod === 'week' }"
              @click="historyPeriod = 'week'"
            >
              {{ t('library.historyWeek') }}
            </button>
            <button
              type="button"
              :class="{ active: historyPeriod === 'all' }"
              @click="historyPeriod = 'all'"
            >
              {{ t('library.historyAll') }}
            </button>
          </div>
          <VirtualTrackList
            v-if="historyTracks.length"
            :tracks="historyTracks"
            :play-counts="historyPlayCounts"
            :current-track-id="player.currentTrack?.id ?? null"
            :pending-track-id="player.pendingTrack?.id ?? null"
            :busy-track-id="busyTrackId"
            @play="playHistoryTrack"
          />
          <div v-else-if="!historyLoading" class="center-state">{{ t('library.empty') }}</div>
          <SectionState
            :loading="historyLoading"
            :error="historyError"
            :has-more="false"
            @retry="loadHistory"
          />
        </div>
      </section>
    </template>

    <Transition name="floating-dialog">
      <div
        v-if="createDialogOpen"
        class="modal-backdrop"
        role="presentation"
        @pointerdown.self="closeCreateDialog"
      >
        <form class="create-dialog" @submit.prevent="createPlaylist">
          <header>
            <h2>{{ t('library.newPlaylist') }}</h2>
            <IconButton icon="x" :title="t('library.close')" @click="closeCreateDialog" />
          </header>
          <label>
            <span>{{ t('library.playlistName') }}</span>
            <input
              ref="createNameInput"
              v-model="createName"
              maxlength="40"
              required
              autocomplete="off"
            />
          </label>
          <label class="private-option">
            <input v-model="createPrivate" type="checkbox" />
            <span>{{ t('library.privatePlaylist') }}</span>
          </label>
          <p v-if="createError" class="operation-error" role="alert">{{ createError }}</p>
          <footer>
            <button type="button" @click="closeCreateDialog">{{ t('library.cancel') }}</button>
            <button class="primary" type="submit" :disabled="createBusy || !createName.trim()">
              <span v-if="createBusy" class="spinner dark" aria-hidden="true"></span>
              <span>{{ t('library.create') }}</span>
            </button>
          </footer>
        </form>
      </div>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import ContentLoadingVeil from '@/components/common/ContentLoadingVeil.vue'
import IconButton from '@/components/common/IconButton.vue'
import { useAuthStore } from '@/features/auth/application/auth-store'
import type { AlbumCard, ArtistCard } from '@/features/catalog/domain/catalog'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import ArtistList from '@/features/catalog/presentation/ArtistList.vue'
import CatalogCoverGrid from '@/features/catalog/presentation/CatalogCoverGrid.vue'
import { usePlayerStore } from '@/features/player/application/player-store'
import {
  PLAYLIST_PAGE_SIZE,
  selectPlaylistTrack,
  type PlaylistDetail,
} from '@/features/playlist/domain/playlist'
import { NativePlaylistGateway } from '@/features/playlist/infrastructure/native-playlist'
import VirtualTrackList from '@/features/search/presentation/VirtualTrackList.vue'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import type { Track } from '@/types/music'
import {
  appendUniqueItems,
  filterLibraryPlaylists,
  type LibraryCatalogSection,
  type LibraryHistory,
  type LibraryHistoryPeriod,
  type LibraryOverview,
  type LibraryPlaylist,
  type LibraryPlaylistFilter,
} from './domain/library'
import { NativeLibraryGateway } from './infrastructure/native-library'
import LibraryEmptyState from './presentation/LibraryEmptyState.vue'
import LibraryPlaylistGrid from './presentation/LibraryPlaylistGrid.vue'
import SectionState from './presentation/LibrarySectionState.vue'

type VisibleLibraryTab = 'playlists' | 'albums' | 'artists' | 'history'
type VisibleCatalogSection = Extract<LibraryCatalogSection, 'albums' | 'artists'>

const props = withDefaults(
  defineProps<{
    section?: VisibleLibraryTab
    playlistFilter?: LibraryPlaylistFilter
    titleKey?: string
  }>(),
  {
    section: 'playlists',
    playlistFilter: 'mine',
    titleKey: 'library.createdPlaylists',
  },
)

const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const player = usePlayerStore()
const libraryGateway = new NativeLibraryGateway()
const playlistGateway = new NativePlaylistGateway()
const catalogGateway = new NativeCatalogGateway()

const overview = shallowRef<LibraryOverview | null>(null)
const playlists = shallowRef<readonly LibraryPlaylist[]>([])
const albums = shallowRef<readonly AlbumCard[]>([])
const artists = shallowRef<readonly ArtistCard[]>([])
const historyCache = shallowRef<Partial<Record<LibraryHistoryPeriod, LibraryHistory>>>({})

const currentTab = computed(() => props.section)
const historyPeriod = ref<LibraryHistoryPeriod>('week')
const overviewLoading = ref(false)
const overviewError = shallowRef<string | null>(null)
const playlistLoading = ref(false)
const playlistError = shallowRef<string | null>(null)
const playlistOffset = ref(0)
const playlistHasMore = ref(false)
const catalogLoading = reactive<Record<VisibleCatalogSection, boolean>>({
  albums: false,
  artists: false,
})
const catalogLoaded = reactive<Record<VisibleCatalogSection, boolean>>({
  albums: false,
  artists: false,
})
const catalogErrors = reactive<Record<VisibleCatalogSection, string | null>>({
  albums: null,
  artists: null,
})
const catalogOffsets = reactive<Record<VisibleCatalogSection, number>>({
  albums: 0,
  artists: 0,
})
const catalogHasMore = reactive<Record<VisibleCatalogSection, boolean>>({
  albums: false,
  artists: false,
})
const historyLoading = ref(false)
const historyError = shallowRef<string | null>(null)
const busyTrackId = ref<number | null>(null)
const busyPlaylistId = ref<number | null>(null)
const operationError = shallowRef<string | null>(null)

const createDialogOpen = ref(false)
const createName = ref('')
const createPrivate = ref(false)
const createBusy = ref(false)
const createError = shallowRef<string | null>(null)
const createNameInput = ref<HTMLInputElement | null>(null)

let overviewController: AbortController | null = null
let tabController: AbortController | null = null
let playbackController: AbortController | null = null
let hydrationController: AbortController | null = null
let createController: AbortController | null = null

const user = computed(() => authStore.session.user)
const authKey = computed(() =>
  authStore.restoring ? 'restoring' : String(authStore.session.user?.userId ?? 'signed-out'),
)
const pageBusy = computed(
  () =>
    overviewLoading.value ||
    playlistLoading.value ||
    historyLoading.value ||
    Object.values(catalogLoading).some(Boolean),
)
const playlistFilter = computed(() => props.playlistFilter)
const pageTitle = computed(() => t(props.titleKey))
const playlistEmptyState = computed(() =>
  playlistFilter.value === 'liked'
    ? {
        title: t('library.emptySavedPlaylists'),
        description: t('library.emptySavedPlaylistsHint'),
      }
    : {
        title: t('library.emptyCreatedPlaylists'),
        description: t('library.emptyCreatedPlaylistsHint'),
      },
)
const filteredPlaylists = computed(() => {
  const currentUser = user.value
  const liked = overview.value?.likedSongs
  if (!currentUser || !liked) return []
  return filterLibraryPlaylists(playlists.value, playlistFilter.value, currentUser.userId, liked.id)
})
const currentHistory = computed(() => historyCache.value[historyPeriod.value] ?? null)
const historyTracks = computed(() => currentHistory.value?.items.map(({ track }) => track) ?? [])
const historyPlayCounts = computed<Readonly<Record<number, number>>>(() =>
  Object.fromEntries(
    (currentHistory.value?.items ?? []).map(({ track, playCount }) => [track.id, playCount]),
  ),
)
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

async function loadOverview(): Promise<void> {
  if (authStore.restoring) return
  const currentUser = user.value
  if (!currentUser) {
    void router.replace('/login/account')
    return
  }
  overviewController?.abort('Library overview superseded')
  tabController?.abort('Library overview superseded')
  const controller = new AbortController()
  overviewController = controller
  overviewLoading.value = true
  overviewError.value = null
  operationError.value = null
  try {
    const loaded = await libraryGateway.overview(currentUser.userId, controller.signal)
    if (overviewController !== controller) return
    overview.value = loaded
    playlists.value = loaded.playlists.items
    playlistOffset.value = loaded.playlists.nextOffset
    playlistHasMore.value = loaded.playlists.hasMore
    ensureCurrentTab()
  } catch (reason) {
    if (!isAbort(reason)) overviewError.value = message(reason)
  } finally {
    if (overviewController === controller) {
      overviewController = null
      overviewLoading.value = false
    }
  }
}

async function loadMorePlaylists(): Promise<void> {
  const currentUser = user.value
  if (!currentUser || playlistLoading.value || !playlistHasMore.value) return
  tabController?.abort('Library playlist page superseded')
  const controller = new AbortController()
  tabController = controller
  playlistLoading.value = true
  playlistError.value = null
  try {
    const page = await libraryGateway.playlistPage(
      currentUser.userId,
      playlistOffset.value,
      controller.signal,
    )
    if (tabController !== controller) return
    playlists.value = appendUniqueItems(playlists.value, page.items)
    playlistOffset.value = page.nextOffset
    playlistHasMore.value = page.hasMore
  } catch (reason) {
    if (!isAbort(reason)) playlistError.value = message(reason)
  } finally {
    if (tabController === controller) {
      tabController = null
      playlistLoading.value = false
    }
  }
}

async function loadCatalog(section: VisibleCatalogSection, more = false): Promise<void> {
  if (catalogLoading[section] || (!more && catalogLoaded[section])) return
  if (more && !catalogHasMore[section]) return
  tabController?.abort('Library catalog page superseded')
  const controller = new AbortController()
  tabController = controller
  catalogLoading[section] = true
  catalogErrors[section] = null
  const offset = more ? catalogOffsets[section] : 0
  try {
    const page = await libraryGateway.catalogPage(section, offset, controller.signal)
    if (tabController !== controller) return
    if (page.section === 'albums') {
      albums.value = more ? appendUniqueItems(albums.value, page.items) : page.items
    } else if (page.section === 'artists') {
      artists.value = more ? appendUniqueItems(artists.value, page.items) : page.items
    } else {
      throw new Error('Unexpected library catalog section')
    }
    catalogOffsets[section] = page.nextOffset
    catalogHasMore[section] = page.hasMore
    catalogLoaded[section] = true
  } catch (reason) {
    if (!isAbort(reason)) catalogErrors[section] = message(reason)
  } finally {
    if (tabController === controller) {
      tabController = null
      catalogLoading[section] = false
    }
  }
}

async function loadHistory(): Promise<void> {
  const currentUser = user.value
  if (!currentUser || historyLoading.value || historyCache.value[historyPeriod.value]) return
  tabController?.abort('Library history superseded')
  const controller = new AbortController()
  tabController = controller
  historyLoading.value = true
  historyError.value = null
  const period = historyPeriod.value
  try {
    const history = await libraryGateway.history(currentUser.userId, period, controller.signal)
    if (tabController !== controller || historyPeriod.value !== period) return
    historyCache.value = { ...historyCache.value, [period]: history }
  } catch (reason) {
    if (!isAbort(reason)) historyError.value = message(reason)
  } finally {
    if (tabController === controller) {
      tabController = null
      historyLoading.value = false
    }
  }
}

function ensureCurrentTab(): void {
  tabController?.abort('Library tab changed')
  if (currentTab.value === 'albums' || currentTab.value === 'artists') {
    void loadCatalog(currentTab.value)
  } else if (currentTab.value === 'history') {
    void loadHistory()
  }
}

async function hydratePlaylistQueue(
  detail: PlaylistDetail,
  sourceKey: string,
  controller: AbortController,
): Promise<void> {
  let offset = detail.nextOffset
  while (
    offset < detail.trackIds.length &&
    hydrationController === controller &&
    player.queueSource === sourceKey
  ) {
    const ids = detail.trackIds.slice(offset, offset + PLAYLIST_PAGE_SIZE)
    if (ids.length === 0) break
    const page = await playlistGateway.trackPage(ids, controller.signal)
    if (hydrationController !== controller || player.queueSource !== sourceKey) return
    player.appendQueue(
      page.tracks.filter((track) => track.playable),
      sourceKey,
    )
    offset += page.requestedCount
  }
}

async function playPlaylistDetail(detail: PlaylistDetail, selectedTrackId?: number): Promise<void> {
  const selection = selectPlaylistTrack(detail.tracks, selectedTrackId)
  if (!selection) {
    operationError.value = t('library.noPlayable')
    return
  }
  playbackController?.abort('Library playback superseded')
  hydrationController?.abort('Library queue superseded')
  const controller = new AbortController()
  playbackController = controller
  busyTrackId.value = selection.track.id
  operationError.value = null
  const sourceKey = `playlist:${detail.id}`
  try {
    const source = await catalogGateway.resolveStream(
      selection.track.id,
      settingsStore.settings.musicQuality,
      controller.signal,
    )
    if (playbackController !== controller) return
    player.setQueue(selection.queue, selection.index, sourceKey)
    await player.load(selection.track, source, true, controller.signal)
    const hydration = new AbortController()
    hydrationController = hydration
    void hydratePlaylistQueue(detail, sourceKey, hydration).catch((reason: unknown) => {
      if (!isAbort(reason)) operationError.value = message(reason)
    })
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (playbackController === controller) {
      playbackController = null
      busyTrackId.value = null
    }
  }
}

async function playPlaylistCard(playlist: LibraryPlaylist): Promise<void> {
  playbackController?.abort('Library playlist selection superseded')
  hydrationController?.abort('Library queue superseded')
  const controller = new AbortController()
  playbackController = controller
  busyPlaylistId.value = playlist.id
  operationError.value = null
  try {
    const detail = await playlistGateway.detail(playlist.id, controller.signal)
    if (playbackController !== controller) return
    playbackController = null
    await playPlaylistDetail(detail)
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (playbackController === controller) playbackController = null
    busyPlaylistId.value = null
  }
}

async function playCollectionTrack(
  track: Track,
  tracks: readonly Track[],
  sourceKey: string,
): Promise<void> {
  const selection = selectPlaylistTrack(tracks, track.id)
  if (!selection) return
  playbackController?.abort('Library track selection superseded')
  hydrationController?.abort('Library collection changed')
  const controller = new AbortController()
  playbackController = controller
  busyTrackId.value = track.id
  operationError.value = null
  try {
    const source = await catalogGateway.resolveStream(
      track.id,
      settingsStore.settings.musicQuality,
      controller.signal,
    )
    if (playbackController !== controller) return
    player.setQueue(selection.queue, selection.index, sourceKey)
    await player.load(selection.track, source, true, controller.signal)
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (playbackController === controller) {
      playbackController = null
      busyTrackId.value = null
    }
  }
}

function playHistoryTrack(track: Track): void {
  void playCollectionTrack(track, historyTracks.value, `library:history:${historyPeriod.value}`)
}

function closeCreateDialog(): void {
  if (createBusy.value) return
  createDialogOpen.value = false
  createName.value = ''
  createPrivate.value = false
  createError.value = null
}

async function createPlaylist(): Promise<void> {
  if (createBusy.value || !createName.value.trim()) return
  createController?.abort('Create playlist superseded')
  const controller = new AbortController()
  createController = controller
  createBusy.value = true
  createError.value = null
  try {
    const created = await libraryGateway.createPlaylist(
      createName.value,
      createPrivate.value,
      controller.signal,
    )
    if (createController !== controller) return
    playlists.value = appendUniqueItems([created], playlists.value)
    createBusy.value = false
    closeCreateDialog()
  } catch (reason) {
    if (!isAbort(reason)) createError.value = message(reason)
  } finally {
    if (createController === controller) {
      createController = null
      createBusy.value = false
    }
  }
}

watch(authKey, () => void loadOverview(), { immediate: true })
watch(currentTab, ensureCurrentTab, { immediate: true })
watch(historyPeriod, () => {
  if (currentTab.value === 'history') void loadHistory()
})
watch(createDialogOpen, async (open) => {
  if (!open) return
  await nextTick()
  createNameInput.value?.focus()
})
watch(
  () => player.queueSource,
  (source) => {
    if (
      hydrationController &&
      source !== `playlist:${busyPlaylistId.value ?? 0}` &&
      source !== `library:history:${historyPeriod.value}`
    ) {
      hydrationController.abort('Library queue ownership changed')
      hydrationController = null
    }
  },
)

onBeforeUnmount(() => {
  overviewController?.abort('Library view disposed')
  tabController?.abort('Library view disposed')
  playbackController?.abort('Library view disposed')
  hydrationController?.abort('Library view disposed')
  createController?.abort('Library view disposed')
})
</script>

<style scoped lang="scss">
.library-view {
  min-height: calc(100vh - 160px);
  color: var(--color-text);
  container-type: inline-size;
}

.library-page-header {
  display: flex;
  min-height: 38px;
  margin: 0 0 24px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;

  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.045em;
  }
}

.library-sections {
  min-height: calc(100vh - 182px);
  margin-top: 0;
}

.tab-action {
  display: flex;
  min-height: 30px;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  background: transparent;
  font-weight: 500;
  opacity: 0.68;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease,
    transform var(--motion-hover-emphasis) var(--ease-out);
  transform-origin: center;

  .app-icon {
    width: 14px;
    height: 14px;
  }

  &:hover:not(:disabled) {
    color: var(--color-text);
    background: transparent;
    opacity: 1;
    transform: scale(1.04);
  }

  &:focus-visible:not(:disabled):not(:hover) {
    color: var(--color-text);
    background: transparent;
    opacity: 1;
    transform: none;
    will-change: auto;
  }

  &:active:not(:disabled) {
    background: transparent;
    transform: scale(1.04);
  }

  &:disabled {
    opacity: 0.34;
  }
}

.section-panel {
  min-height: 260px;
}

.history-periods {
  display: flex;
  margin-bottom: 12px;
  gap: 4px;

  button {
    position: relative;
    min-height: 30px;
    padding: 5px 7px;
    border: 0;
    border-radius: var(--radius-xs);
    color: var(--color-text-secondary);
    background: transparent;
    font-weight: 500;
    opacity: 0.72;
    transition:
      color var(--motion-fast) ease,
      opacity var(--motion-fast) ease,
      transform var(--motion-hover-emphasis) var(--ease-out);
    transform-origin: center;

    &:hover {
      color: var(--color-text);
      background: transparent;
      opacity: 1;
      transform: scale(1.04);
    }

    &:focus-visible:not(:hover) {
      color: var(--color-text);
      background: transparent;
      opacity: 1;
      transform: none;
      will-change: auto;
    }

    &.active {
      color: var(--color-text);
      background: transparent;
      font-weight: var(--font-weight-medium);
      opacity: 1;

      &::after {
        position: absolute;
        right: 8px;
        bottom: 2px;
        left: 8px;
        height: 1px;
        background: currentcolor;
        content: '';
        opacity: 0.72;
      }
    }
  }
}

.operation-error {
  margin: 0 0 18px;
  color: var(--color-danger);
  font-size: 14px;
}

.modal-backdrop {
  position: fixed;
  z-index: var(--z-overlay);
  inset: 0;
  display: grid;
  padding: 24px;
  place-items: center;
  background: var(--color-overlay-scrim);
  backdrop-filter: blur(12px);
}

.create-dialog {
  width: min(420px, 100%);
  padding: 24px;
  border: 0.5px solid var(--floating-border);
  border-radius: var(--floating-dialog-radius);
  color: var(--color-text);
  background: var(--floating-surface);
  box-shadow: var(--floating-dialog-shadow);
  backdrop-filter: saturate(160%) blur(30px);

  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 19px;
  }

  > label:not(.private-option) {
    display: flex;
    margin-top: 24px;
    flex-direction: column;
    gap: 8px;

    span {
      font-size: 14px;
      font-weight: 600;
    }

    input {
      width: 100%;
      height: 42px;
      padding: 0 12px;
      border: 1px solid var(--floating-border);
      border-radius: 10px;
      color: var(--color-text);
      background: var(--color-surface-low);
    }
  }

  .private-option {
    display: flex;
    margin-top: 16px;
    align-items: center;
    gap: 9px;
    font-size: 14px;
  }

  footer {
    margin-top: 24px;
    justify-content: flex-end;

    button {
      min-width: 84px;
      min-height: 38px;
      padding: 0 14px;
      border: 0;
      border-radius: 999px;
      color: var(--color-text);
      background: var(--color-surface-low);
      font-weight: 600;
      transition:
        background-color 140ms ease,
        transform 120ms ease;

      &:hover:not(:disabled) {
        background: var(--floating-item-hover);
      }

      &:active:not(:disabled) {
        transform: scale(0.96);
      }

      &.primary {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--color-on-primary);
        background: var(--color-primary);
      }
    }
  }
}

.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

.spinner.dark {
  color: var(--color-on-primary);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tab-action,
  .history-periods button {
    transition: none;

    &:hover,
    &:focus-visible,
    &:active {
      transform: none;
      will-change: auto;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .tab-action {
    transition: none;
  }
}
</style>
