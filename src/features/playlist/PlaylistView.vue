<template>
  <section class="playlist-view" :aria-busy="loading || loadingMore || hydrating">
    <ContentLoadingVeil
      v-if="(likedSongsPage && !authStore.session.user) || loading"
      :label="t('playlist.loading')"
      min-height="clamp(280px, 42vh, 420px)"
    />

    <div v-else-if="loadError && !detail" class="center-state request-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" @click="reloadDetail">{{ t('playlist.retry') }}</button>
    </div>

    <template v-else-if="detail">
      <header v-if="likedSongsPage" class="liked-songs-header">
        <h1>
          <CoverImage
            v-if="authStore.session.user?.avatarUrl"
            :source="authStore.session.user.avatarUrl"
            :width="44"
            role="avatar"
            alt=""
            decoding="async"
          />
          <span>{{ authStore.session.user?.nickname }}{{ t('library.likedSongsSuffix') }}</span>
        </h1>
        <div class="liked-search">
          <IconButton
            icon="search"
            :title="t('playlist.search')"
            :aria-expanded="searchOpen"
            @click="toggleSearch"
          />
          <label v-if="searchOpen" class="liked-search-input">
            <input
              ref="searchInput"
              v-model="searchDraft"
              type="search"
              :placeholder="t('playlist.search')"
              :aria-label="t('playlist.search')"
            />
          </label>
        </div>
      </header>

      <header v-else-if="specialPlaylist" class="special-playlist">
        <h1 :class="specialPlaylist.gradient">{{ specialPlaylist.name }}</h1>
        <p>{{ detail.name }}</p>
        <div class="header-actions">
          <button class="primary-action neutral" type="button" :disabled="busy" @click="playFirst">
            <AppIcon name="play" />
            <span>{{ t('playlist.play') }}</span>
          </button>
          <IconButton
            v-if="canSubscribe"
            :icon="detail.subscribed ? 'heart-solid' : 'heart'"
            :title="t(detail.subscribed ? 'playlist.remove' : 'playlist.save')"
            :disabled="subscriptionBusy"
            @click="toggleSubscription"
          />
          <div ref="menuRoot" class="menu-anchor">
            <IconButton
              icon="more"
              :title="t('playlist.more')"
              :class="{ active: menuOpen }"
              @click.stop="menuOpen = !menuOpen"
            />
            <Transition name="floating-menu">
              <div v-if="menuOpen" class="action-menu" role="menu">
                <button type="button" role="menuitem" @click="toggleSearch">
                  <AppIcon name="search" />
                  <span>{{ t('playlist.search') }}</span>
                </button>
                <button
                  v-if="canSubscribe"
                  type="button"
                  role="menuitem"
                  :disabled="subscriptionBusy"
                  @click="toggleSubscription"
                >
                  <AppIcon :name="detail.subscribed ? 'heart-solid' : 'heart'" />
                  <span>{{ t(detail.subscribed ? 'playlist.remove' : 'playlist.save') }}</span>
                </button>
                <button
                  v-if="canEdit"
                  type="button"
                  role="menuitem"
                  :disabled="mutationBusy"
                  @click="renamePlaylist"
                >
                  <AppIcon name="settings" />
                  <span>{{ t('playlist.rename') }}</span>
                </button>
                <button
                  v-if="canEdit"
                  type="button"
                  role="menuitem"
                  :disabled="mutationBusy"
                  @click="editDescription"
                >
                  <AppIcon name="settings" />
                  <span>{{ t('playlist.editDescription') }}</span>
                </button>
                <button
                  v-if="canEdit"
                  type="button"
                  role="menuitem"
                  :disabled="mutationBusy"
                  @click="removePlaylist"
                >
                  <AppIcon name="x" />
                  <span>{{ t('playlist.delete') }}</span>
                </button>
              </div>
            </Transition>
          </div>
        </div>
        <label v-if="searchOpen" class="playlist-search special-search">
          <AppIcon name="search" />
          <input
            ref="searchInput"
            v-model="searchDraft"
            type="search"
            :placeholder="t('playlist.search')"
            :aria-label="t('playlist.search')"
          />
        </label>
      </header>

      <header v-else class="playlist-header">
        <button
          class="cover-button"
          type="button"
          :title="t('playlist.play')"
          :disabled="busy"
          @click="playFirst"
        >
          <CoverImage
            :source="detail.coverUrl"
            :width="232"
            role="hero"
            :alt="detail.name"
            decoding="async"
          />
          <span class="cover-play"><AppIcon name="play" /></span>
        </button>

        <div class="playlist-copy">
          <h1>
            <AppIcon v-if="detail.private" class="lock-icon" name="lock" />
            <span>{{ detail.name }}</span>
          </h1>
          <p class="creator">
            {{ t('playlist.by') }}
            <a
              v-if="detail.creator.userId > 0"
              :href="creatorUrl"
              target="_blank"
              rel="noreferrer"
              >{{ detail.creator.name }}</a
            >
            <strong v-else>{{ detail.creator.name }}</strong>
          </p>
          <p class="date-count">
            {{ t('playlist.updatedAt') }} {{ formattedDate }} · {{ detail.trackCount }}
            {{ t('playlist.songs') }}
          </p>
          <button
            v-if="detail.description"
            class="description-preview"
            type="button"
            @click="descriptionOpen = true"
          >
            {{ detail.description }}
          </button>
          <div class="header-actions">
            <button class="primary-action" type="button" :disabled="busy" @click="playFirst">
              <AppIcon name="play" />
              <span>{{ t('playlist.play') }}</span>
            </button>
            <IconButton
              v-if="canSubscribe"
              :icon="detail.subscribed ? 'heart-solid' : 'heart'"
              :title="t(detail.subscribed ? 'playlist.remove' : 'playlist.save')"
              :disabled="subscriptionBusy"
              @click="toggleSubscription"
            />
            <div ref="menuRoot" class="menu-anchor">
              <IconButton
                icon="more"
                :title="t('playlist.more')"
                :class="{ active: menuOpen }"
                @click.stop="menuOpen = !menuOpen"
              />
              <Transition name="floating-menu">
                <div v-if="menuOpen" class="action-menu" role="menu">
                  <button type="button" role="menuitem" @click="toggleSearch">
                    <AppIcon name="search" />
                    <span>{{ t('playlist.search') }}</span>
                  </button>
                  <button
                    v-if="canSubscribe"
                    type="button"
                    role="menuitem"
                    :disabled="subscriptionBusy"
                    @click="toggleSubscription"
                  >
                    <AppIcon :name="detail.subscribed ? 'heart-solid' : 'heart'" />
                    <span>{{ t(detail.subscribed ? 'playlist.remove' : 'playlist.save') }}</span>
                  </button>
                  <button
                    v-if="canEdit"
                    type="button"
                    role="menuitem"
                    :disabled="mutationBusy"
                    @click="renamePlaylist"
                  >
                    <AppIcon name="settings" />
                    <span>{{ t('playlist.rename') }}</span>
                  </button>
                  <button
                    v-if="canEdit"
                    type="button"
                    role="menuitem"
                    :disabled="mutationBusy"
                    @click="editDescription"
                  >
                    <AppIcon name="settings" />
                    <span>{{ t('playlist.editDescription') }}</span>
                  </button>
                  <button
                    v-if="canEdit"
                    type="button"
                    role="menuitem"
                    :disabled="mutationBusy"
                    @click="removePlaylist"
                  >
                    <AppIcon name="x" />
                    <span>{{ t('playlist.delete') }}</span>
                  </button>
                </div>
              </Transition>
            </div>
          </div>
        </div>

        <label v-if="searchOpen" class="playlist-search">
          <AppIcon name="search" />
          <input
            ref="searchInput"
            v-model="searchDraft"
            type="search"
            :placeholder="t('playlist.search')"
            :aria-label="t('playlist.search')"
          />
        </label>
      </header>

      <p v-if="subscriptionMessage" class="feedback" role="status">{{ subscriptionMessage }}</p>
      <p v-if="operationError" class="feedback error" role="alert">{{ operationError }}</p>

      <VirtualTrackList
        v-if="filteredTracks.length"
        :tracks="filteredTracks"
        :current-track-id="player.currentTrack?.id ?? null"
        :pending-track-id="player.pendingTrack?.id ?? null"
        :busy-track-id="busyTrackId"
        :removable="canEdit"
        @play="playTrack"
        @remove="removeTrackAt"
      />
      <div v-else class="center-state">{{ t('playlist.noTracks') }}</div>

      <div v-if="hasMore" class="load-more">
        <button
          class="flat-action"
          type="button"
          :disabled="loadingMore || hydrating"
          @click="loadMore"
        >
          <span v-if="loadingMore || hydrating" class="spinner" aria-hidden="true"></span>
          <AppIcon v-else name="arrow-down" />
          <span>{{
            loadingMore || hydrating ? t('playlist.loading') : t('playlist.loadMore')
          }}</span>
        </button>
      </div>
    </template>

    <DescriptionDialog
      :open="descriptionOpen && Boolean(detail)"
      :title="t('playlist.descriptionTitle')"
      :close-label="t('playlist.close')"
      :description="detail?.description ?? ''"
      @close="descriptionOpen = false"
    />

    <Transition name="floating-dialog">
      <div
        v-if="mutationDialog"
        class="modal-backdrop"
        role="presentation"
        @pointerdown.self="closeMutationDialog"
      >
        <form
          class="mutation-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="mutationDialogTitle"
          @submit.prevent="submitMutationDialog"
        >
          <header>
            <h2>{{ mutationDialogTitle }}</h2>
            <IconButton
              icon="x"
              :title="t('playlist.close')"
              :disabled="mutationBusy"
              @click="closeMutationDialog"
            />
          </header>

          <label v-if="mutationDialog.kind === 'rename'" class="mutation-field">
            <input
              ref="mutationInput"
              v-model="mutationDraft"
              type="text"
              :aria-label="t('playlist.rename')"
            />
          </label>
          <label v-else-if="mutationDialog.kind === 'description'" class="mutation-field">
            <textarea
              ref="mutationInput"
              v-model="mutationDraft"
              rows="5"
              :aria-label="t('playlist.editDescription')"
            ></textarea>
          </label>
          <p v-else class="mutation-message">{{ mutationDialogMessage }}</p>

          <div class="mutation-actions">
            <button type="button" :disabled="mutationBusy" @click="closeMutationDialog">
              {{ t('settings.cancel') }}
            </button>
            <button
              type="submit"
              :class="{ danger: mutationDialogDestructive }"
              :disabled="mutationBusy || mutationDialogSubmitDisabled"
            >
              {{ mutationDialogConfirmLabel }}
            </button>
          </div>
        </form>
      </div>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import ContentLoadingVeil from '@/components/common/ContentLoadingVeil.vue'
import DescriptionDialog from '@/components/common/DescriptionDialog.vue'
import IconButton from '@/components/common/IconButton.vue'
import { parsePositiveIntegerRouteParam } from '@/app/route-params'
import { useAuthStore } from '@/features/auth/application/auth-store'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import { onTrackLikeChange } from '@/features/player/application/track-like-events'
import { releaseAudioSource } from '@/features/player/domain/audio-engine'
import { usePlayerStore } from '@/features/player/application/player-store'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import VirtualTrackList from '@/features/search/presentation/VirtualTrackList.vue'
import type { Track } from '@/types/music'
import {
  PLAYLIST_PAGE_SIZE,
  appendPlaylistTrackPage,
  filterPlaylistTracks,
  selectPlaylistTrack,
  type PlaylistDetail,
} from './domain/playlist'
import { NativePlaylistGateway } from './infrastructure/native-playlist'

const specialPlaylists: Readonly<Record<number, { name: string; gradient: string }>> = {
  2829816518: { name: '欧美私人订制', gradient: 'gradient-pink-purple-blue' },
  2890490211: { name: '助眠鸟鸣声', gradient: 'gradient-green' },
  5089855855: { name: '夜的胡思乱想', gradient: 'gradient-moonstone-blue' },
  2888212971: { name: '全球百大DJ', gradient: 'gradient-orange-red' },
  2829733864: { name: '睡眠伴侣', gradient: 'gradient-midnight-blue' },
  2829844572: { name: '洗澡时听的歌', gradient: 'gradient-yellow' },
  2920647537: { name: '还是会想你', gradient: 'gradient-dark-blue-midnight-blue' },
  2890501416: { name: '助眠白噪声', gradient: 'gradient-sky-blue' },
  5217150082: { name: '摇滚唱片行', gradient: 'gradient-yellow-red' },
  2829961453: { name: '古风音乐大赏', gradient: 'gradient-fog' },
  4923261701: { name: 'Trance', gradient: 'gradient-light-red-light-blue' },
  5212729721: { name: '欧美点唱机', gradient: 'gradient-indigo-pink-yellow' },
  3103434282: { name: '甜蜜少女心', gradient: 'gradient-pink' },
  2829896389: { name: '日系私人订制', gradient: 'gradient-yellow-pink' },
  2829779628: { name: '运动随身听', gradient: 'gradient-orange-red' },
  2860654884: { name: '独立女声精选', gradient: 'gradient-sharp-blue' },
  898150: { name: '浪漫婚礼专用', gradient: 'gradient-pink' },
  2638104052: { name: '牛奶泡泡浴', gradient: 'gradient-fog' },
  5317236517: { name: '后朋克精选', gradient: 'gradient-pink-purple-blue' },
  2821115454: { name: '一周原创发现', gradient: 'gradient-blue-purple' },
  2829883282: { name: '华语私人雷达', gradient: 'gradient-yellow-red' },
  3136952023: { name: '私人雷达', gradient: 'gradient-radar' },
}

const CACHED_DETAIL_REVALIDATE_MS = 2 * 60 * 1_000

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const authStore = useAuthStore()
const playlistGateway = new NativePlaylistGateway()
const catalogGateway = new NativeCatalogGateway()
const detail = shallowRef<PlaylistDetail | null>(null)
const tracks = shallowRef<readonly Track[]>([])
const nextOffset = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const hydrating = ref(false)
const subscriptionBusy = ref(false)
const mutationBusy = ref(false)
const busyTrackId = ref<number | null>(null)
const loadError = shallowRef<string | null>(null)
const operationError = shallowRef<string | null>(null)
const subscriptionMessage = shallowRef<string | null>(null)
const searchOpen = ref(false)
const searchDraft = ref('')
const searchKeywords = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const descriptionOpen = ref(false)
const menuOpen = ref(false)
const menuRoot = ref<ReturnType<typeof document.querySelector> | null>(null)
type MutationDialog =
  | { readonly kind: 'rename' | 'description' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'remove-track'; readonly track: Track }
const mutationDialog = shallowRef<MutationDialog | null>(null)
const mutationDraft = ref('')
const mutationInput = ref<globalThis.HTMLInputElement | globalThis.HTMLTextAreaElement | null>(null)
let detailController: AbortController | null = null
let pageController: AbortController | null = null
let playbackController: AbortController | null = null
let subscriptionController: AbortController | null = null
let searchTimer: ReturnType<typeof globalThis.setTimeout> | null = null
let stopTrackLikeSync: (() => void) | null = null
let viewActive = true
let loadedRequestKey: string | null = null
let detailLoadedAt = 0

const playlistId = computed(() => parsePositiveIntegerRouteParam(route.params.id))
const likedSongsPage = computed(() => route.name === 'likedSongs')
const likedUserId = computed(() => authStore.session.user?.userId ?? null)
const requestKey = computed(() =>
  likedSongsPage.value
    ? `liked:${authStore.restoring ? 'restoring' : (likedUserId.value ?? 'signed-out')}`
    : `playlist:${playlistId.value ?? 'invalid'}`,
)
const sourceKey = computed(() =>
  likedSongsPage.value ? `liked:${likedUserId.value ?? 0}` : `playlist:${playlistId.value ?? 0}`,
)
const specialPlaylist = computed(() =>
  likedSongsPage.value || playlistId.value === null
    ? undefined
    : specialPlaylists[playlistId.value],
)
const filteredTracks = computed(() => filterPlaylistTracks(tracks.value, searchKeywords.value))
const busy = computed(
  () => busyTrackId.value !== null || tracks.value.every((track) => !track.playable),
)
const mutationDialogTitle = computed(() => {
  switch (mutationDialog.value?.kind) {
    case 'rename':
      return t('playlist.rename')
    case 'description':
      return t('playlist.editDescription')
    case 'delete':
      return t('playlist.delete')
    case 'remove-track':
      return t('playlist.removeTrackConfirm')
    default:
      return ''
  }
})
const mutationDialogMessage = computed(() => {
  if (mutationDialog.value?.kind === 'delete') return t('playlist.deleteConfirm')
  if (mutationDialog.value?.kind === 'remove-track') return mutationDialog.value.track.name
  return ''
})
const mutationDialogDestructive = computed(
  () => mutationDialog.value?.kind === 'delete' || mutationDialog.value?.kind === 'remove-track',
)
const mutationDialogConfirmLabel = computed(() => {
  if (mutationDialog.value?.kind === 'delete') return t('playlist.delete')
  if (mutationDialog.value?.kind === 'remove-track') return t('playlist.confirm')
  return t('settings.apply')
})
const mutationDialogSubmitDisabled = computed(
  () => mutationDialog.value?.kind === 'rename' && mutationDraft.value.trim().length === 0,
)
const canSubscribe = computed(
  () =>
    authStore.session.authenticated &&
    !likedSongsPage.value &&
    detail.value !== null &&
    detail.value.creator.userId !== authStore.session.user?.userId,
)
const canEdit = computed(
  () =>
    authStore.session.authenticated &&
    !likedSongsPage.value &&
    detail.value !== null &&
    detail.value.creator.userId === authStore.session.user?.userId,
)
const creatorUrl = computed(
  () => `https://music.163.com/#/user/home?id=${detail.value?.creator.userId ?? 0}`,
)
const formattedDate = computed(() =>
  new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'short', day: 'numeric' }).format(
    new Date(detail.value?.updateTime ?? 0),
  ),
)

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function reloadDetail(): void {
  void loadDetail(false)
}

function refreshCachedDetail(): void {
  void loadDetail(true)
}

async function loadDetail(preserveContent: boolean): Promise<void> {
  const nextRequestKey = requestKey.value
  const retainingContent =
    preserveContent && detail.value !== null && loadedRequestKey === nextRequestKey
  detailController?.abort('Playlist detail superseded')
  detailController = null
  loading.value = false
  loadError.value = null
  if (!retainingContent) {
    pageController?.abort('Playlist changed')
    playbackController?.abort('Playlist changed')
    operationError.value = null
    searchOpen.value = false
    searchDraft.value = ''
    searchKeywords.value = ''
    detail.value = null
    tracks.value = []
    loadedRequestKey = null
    detailLoadedAt = 0
  }
  if (likedSongsPage.value && authStore.restoring) return
  const id = likedSongsPage.value ? likedUserId.value : playlistId.value
  if (id === null) {
    if (likedSongsPage.value) void router.replace('/login/account')
    return
  }
  const controller = new AbortController()
  detailController = controller
  loading.value = true
  try {
    const loaded = likedSongsPage.value
      ? await playlistGateway.likedSongs(id, controller.signal)
      : await playlistGateway.detail(id, controller.signal)
    if (detailController !== controller || !viewActive || requestKey.value !== nextRequestKey) {
      return
    }
    detail.value = loaded
    tracks.value = loaded.tracks
    nextOffset.value = loaded.nextOffset
    hasMore.value = loaded.hasMore
    loadedRequestKey = nextRequestKey
    detailLoadedAt = Date.now()
  } catch (reason) {
    if (!isAbort(reason) && !retainingContent) loadError.value = message(reason)
  } finally {
    if (detailController === controller) {
      detailController = null
      loading.value = false
    }
  }
}

function suspendCachedView(): void {
  viewActive = false
  detailController?.abort('Playlist view hidden')
  detailController = null
  pageController?.abort('Playlist view hidden')
  pageController = null
  playbackController?.abort('Playlist view hidden')
  playbackController = null
  loading.value = false
  loadingMore.value = false
  hydrating.value = false
}

function resumeCachedView(): void {
  viewActive = true
  if (detailController !== null || loading.value) return
  if (detail.value === null || loadedRequestKey !== requestKey.value) {
    reloadDetail()
    return
  }
  if (Date.now() - detailLoadedAt >= CACHED_DETAIL_REVALIDATE_MS) refreshCachedDetail()
}

async function requestNextPage(controller: AbortController): Promise<boolean> {
  const current = detail.value
  if (!current || nextOffset.value >= current.trackIds.length) return false
  const requestedIds = current.trackIds.slice(
    nextOffset.value,
    nextOffset.value + PLAYLIST_PAGE_SIZE,
  )
  if (requestedIds.length === 0) return false
  const page = await playlistGateway.trackPage(requestedIds, controller.signal)
  if (pageController !== controller) return false
  const appended = appendPlaylistTrackPage(
    tracks.value,
    nextOffset.value,
    current.trackIds.length,
    page,
  )
  tracks.value = appended.tracks
  nextOffset.value = appended.nextOffset
  hasMore.value = appended.hasMore
  player.appendQueue(
    page.tracks.filter((track) => track.playable),
    sourceKey.value,
  )
  return appended.hasMore
}

async function loadMore(): Promise<void> {
  if (loadingMore.value || hydrating.value || !hasMore.value) return
  pageController?.abort('Playlist page superseded')
  const controller = new AbortController()
  pageController = controller
  loadingMore.value = true
  operationError.value = null
  try {
    await requestNextPage(controller)
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (pageController === controller) {
      pageController = null
      loadingMore.value = false
    }
  }
}

async function hydrateRemaining(): Promise<void> {
  // Full hydration is deliberately reserved for an explicit in-page search.
  // Normal playback now receives a small, on-demand queue continuation from
  // the player store rather than keeping every row and cover alive here.
  if (!viewActive || !searchOpen.value || hydrating.value || !hasMore.value) return
  pageController?.abort('Playlist hydration superseded')
  const controller = new AbortController()
  pageController = controller
  hydrating.value = true
  operationError.value = null
  try {
    while (
      viewActive &&
      searchOpen.value &&
      pageController === controller &&
      (await requestNextPage(controller))
    ) {
      // Sequential bounded pages prevent request bursts and keep cancellation immediate.
    }
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (pageController === controller) {
      pageController = null
      hydrating.value = false
    }
  }
}

function configureQueueContinuation(current: PlaylistDetail): void {
  const expectedSource = sourceKey.value
  let continuationOffset = nextOffset.value
  player.setQueueContinuation(expectedSource, {
    async loadNext(signal) {
      // A manually loaded page may have advanced the visible list since the
      // continuation was registered.  It has already been appended to the
      // player queue, so skip it instead of downloading it a second time.
      if (detail.value === current && sourceKey.value === expectedSource) {
        continuationOffset = Math.max(continuationOffset, nextOffset.value)
      }
      const requestedIds = current.trackIds.slice(
        continuationOffset,
        continuationOffset + PLAYLIST_PAGE_SIZE,
      )
      if (requestedIds.length === 0) return { tracks: [], hasMore: false }
      const page = await playlistGateway.trackPage(requestedIds, signal)
      const consumed = Math.max(page.requestedCount, requestedIds.length)
      continuationOffset = Math.min(current.trackIds.length, continuationOffset + consumed)
      return {
        tracks: page.tracks.filter((candidate) => candidate.playable),
        hasMore: continuationOffset < current.trackIds.length,
      }
    },
  })
}

async function playTrack(track: Track): Promise<void> {
  const selection = selectPlaylistTrack(tracks.value, track.id)
  if (!selection) return
  playbackController?.abort('Playlist track selection superseded')
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
    if (playbackController !== controller) {
      releaseAudioSource(source)
      return
    }
    player.setQueue(selection.queue, selection.index, sourceKey.value)
    await player.load(selection.track, source, true, controller.signal)
    const current = detail.value
    if (current !== null && sourceKey.value === player.queueSource)
      configureQueueContinuation(current)
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (playbackController === controller) {
      playbackController = null
      busyTrackId.value = null
    }
  }
}

function playFirst(): void {
  const selection = selectPlaylistTrack(tracks.value)
  if (selection) void playTrack(selection.track)
}

async function toggleSubscription(): Promise<void> {
  const current = detail.value
  if (!current || !canSubscribe.value || subscriptionBusy.value) return
  menuOpen.value = false
  subscriptionController?.abort('Playlist subscription superseded')
  const controller = new AbortController()
  subscriptionController = controller
  subscriptionBusy.value = true
  operationError.value = null
  subscriptionMessage.value = null
  const subscribed = !current.subscribed
  try {
    await playlistGateway.setSubscription(current.id, subscribed, controller.signal)
    if (subscriptionController !== controller) return
    detail.value = { ...current, subscribed }
    subscriptionMessage.value = t(subscribed ? 'playlist.saved' : 'playlist.removed')
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (subscriptionController === controller) {
      subscriptionController = null
      subscriptionBusy.value = false
    }
  }
}

async function runMutation(action: () => Promise<void>): Promise<boolean> {
  if (mutationBusy.value) return false
  mutationBusy.value = true
  operationError.value = null
  try {
    await action()
    return true
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
    return false
  } finally {
    mutationBusy.value = false
  }
}

async function focusMutationField(): Promise<void> {
  await nextTick()
  mutationInput.value?.focus()
  mutationInput.value?.select()
}

function closeMutationDialog(): void {
  if (mutationBusy.value) return
  mutationDialog.value = null
  mutationDraft.value = ''
}

function renamePlaylist(): void {
  const current = detail.value
  if (!current || !canEdit.value) return
  menuOpen.value = false
  mutationDraft.value = current.name
  mutationDialog.value = { kind: 'rename' }
  void focusMutationField()
}

function editDescription(): void {
  const current = detail.value
  if (!current || !canEdit.value) return
  menuOpen.value = false
  mutationDraft.value = current.description
  mutationDialog.value = { kind: 'description' }
  void focusMutationField()
}

function removePlaylist(): void {
  const current = detail.value
  if (!current || !canEdit.value) return
  menuOpen.value = false
  mutationDialog.value = { kind: 'delete' }
}

function removeTrackAt(index: number): void {
  const track = filteredTracks.value[index]
  if (!detail.value || !track || !canEdit.value) return
  mutationDialog.value = { kind: 'remove-track', track }
}

async function submitMutationDialog(): Promise<void> {
  const current = detail.value
  const dialog = mutationDialog.value
  if (!current || !dialog) return

  if (dialog.kind === 'rename') {
    const name = mutationDraft.value.trim()
    if (!name) return
    if (
      name !== current.name &&
      (await runMutation(() => playlistGateway.updateName(current.id, name)))
    ) {
      detail.value = { ...current, name }
    }
  } else if (dialog.kind === 'description') {
    const description = mutationDraft.value
    if (
      description !== current.description &&
      (await runMutation(() => playlistGateway.updateDescription(current.id, description)))
    ) {
      detail.value = { ...current, description }
    }
  } else if (dialog.kind === 'delete') {
    if (!(await runMutation(() => playlistGateway.deletePlaylist(current.id)))) return
    mutationDialog.value = null
    await router.replace('/library')
    return
  } else if (
    dialog.kind === 'remove-track' &&
    (await runMutation(() => playlistGateway.removeTracks(current.id, [dialog.track.id])))
  ) {
    tracks.value = tracks.value.filter(({ id }) => id !== dialog.track.id)
    detail.value = {
      ...current,
      trackIds: current.trackIds.filter((id) => id !== dialog.track.id),
      trackCount: Math.max(0, current.trackCount - 1),
    }
    hasMore.value = nextOffset.value < Math.max(0, current.trackIds.length - 1)
  }

  if (!operationError.value) closeMutationDialog()
}

async function toggleSearch(): Promise<void> {
  menuOpen.value = false
  searchOpen.value = !searchOpen.value
  if (!searchOpen.value) {
    searchDraft.value = ''
    searchKeywords.value = ''
    if (player.queueSource !== sourceKey.value) pageController?.abort('Playlist search closed')
    return
  }
  await nextTick()
  searchInput.value?.focus()
  void hydrateRemaining()
}

function closeMenuOnOutsideClick(event: Event): void {
  if (!menuRoot.value?.contains(event.target as ReturnType<typeof document.querySelector>)) {
    menuOpen.value = false
  }
}

function closeTransientUi(event: Event): void {
  if (!(event instanceof globalThis.KeyboardEvent) || event.key !== 'Escape') return
  menuOpen.value = false
  descriptionOpen.value = false
  closeMutationDialog()
}

function syncLikedSongs(track: Track, liked: boolean): void {
  if (!likedSongsPage.value || detail.value === null) return
  const current = detail.value
  const hasTrackId = current.trackIds.includes(track.id)
  const inLoadedRows = tracks.value.some(({ id }) => id === track.id)
  if (liked && !hasTrackId) {
    tracks.value = [track, ...tracks.value.filter(({ id }) => id !== track.id)]
    detail.value = {
      ...current,
      trackIds: [track.id, ...current.trackIds.filter((id) => id !== track.id)],
      trackCount: current.trackCount + 1,
    }
    nextOffset.value += 1
    return
  }
  if (!liked && hasTrackId) {
    if (inLoadedRows) tracks.value = tracks.value.filter(({ id }) => id !== track.id)
    detail.value = {
      ...current,
      trackIds: current.trackIds.filter((id) => id !== track.id),
      trackCount: Math.max(0, current.trackCount - 1),
    }
    if (inLoadedRows) nextOffset.value = Math.max(0, nextOffset.value - 1)
    nextOffset.value = Math.min(nextOffset.value, detail.value.trackIds.length)
    hasMore.value = nextOffset.value < detail.value.trackIds.length
  }
}

watch(
  requestKey,
  () => {
    if (viewActive) reloadDetail()
  },
  { immediate: true },
)
watch(searchDraft, (value) => {
  if (searchTimer !== null) globalThis.clearTimeout(searchTimer)
  searchTimer = globalThis.setTimeout(() => {
    searchKeywords.value = value
    searchTimer = null
  }, 180)
})
watch(
  () => player.queueSource,
  (queueSource) => {
    if (hydrating.value && !searchOpen.value && queueSource !== sourceKey.value) {
      pageController?.abort('Playlist queue ownership changed')
    }
  },
)

onMounted(() => {
  stopTrackLikeSync = onTrackLikeChange(({ track, liked }) => syncLikedSongs(track, liked))
  document.addEventListener('pointerdown', closeMenuOnOutsideClick)
  document.addEventListener('keydown', closeTransientUi)
})
onBeforeRouteLeave(suspendCachedView)
onActivated(resumeCachedView)
onDeactivated(suspendCachedView)
onBeforeUnmount(() => {
  viewActive = false
  detailController?.abort('Playlist view disposed')
  pageController?.abort('Playlist view disposed')
  playbackController?.abort('Playlist view disposed')
  subscriptionController?.abort('Playlist view disposed')
  stopTrackLikeSync?.()
  if (searchTimer !== null) globalThis.clearTimeout(searchTimer)
  document.removeEventListener('pointerdown', closeMenuOnOutsideClick)
  document.removeEventListener('keydown', closeTransientUi)
})
</script>

<style scoped lang="scss">
.playlist-view {
  min-height: calc(100vh - 160px);
  color: var(--color-text);
}

.liked-songs-header {
  display: flex;
  min-height: 80px;
  margin-bottom: 28px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;

  h1 {
    display: flex;
    min-width: 0;
    margin: 0;
    align-items: center;
    font-family: var(--font-display);
    font-size: clamp(30px, 3vw, 42px);
    line-height: 1.15;
    letter-spacing: -0.05em;

    img {
      width: 44px;
      height: 44px;
      margin-right: 12px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      flex: 0 0 44px;
      object-fit: cover;
    }

    span {
      overflow-wrap: anywhere;
    }
  }
}

.liked-search {
  display: flex;
  height: 36px;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.liked-search-input {
  display: flex;
  width: 172px;
  height: 34px;
  padding: 0 10px;
  align-items: center;
  border-radius: 8px;
  background: var(--color-primary-bg-for-transparent);

  input {
    width: 100%;
    min-width: 0;
    border: 0;
    color: var(--color-text);
    font-size: 15px;
    font-weight: 600;
    background: transparent;
  }
}

.playlist-header {
  position: relative;
  display: flex;
  min-height: 232px;
  margin-bottom: 48px;
}

.cover-button {
  position: relative;
  z-index: 0;
  width: 232px;
  height: 232px;
  padding: 0;
  border: 0;
  flex: 0 0 232px;
  background: transparent;

  img {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    object-fit: cover;
  }

  &:hover .cover-play,
  &:focus-visible .cover-play {
    opacity: 1;
    transform: scale(1);
  }
}

.cover-play {
  position: absolute;
  z-index: 2;
  right: 16px;
  bottom: 16px;
  display: grid;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 5px;
  place-items: center;
  color: var(--color-text);
  background: rgb(0 0 0 / 66%);
  opacity: 0;
  transform: scale(0.86);
  transition:
    opacity 160ms ease,
    transform 160ms ease;

  .app-icon {
    width: 18px;
    height: 18px;
  }
}

.playlist-copy {
  display: flex;
  min-width: 0;
  margin-left: 40px;
  flex: 1;
  flex-direction: column;
  justify-content: center;

  h1 {
    display: flex;
    min-width: 0;
    margin: 0;
    align-items: center;
    font-family: var(--font-display);
    font-size: clamp(32px, 3.4vw, 48px);
    line-height: 0.98;
    letter-spacing: -0.06em;

    span {
      overflow-wrap: anywhere;
    }
  }
}

.lock-icon {
  width: 26px;
  height: 26px;
  margin-right: 8px;
  opacity: 0.28;
}

.creator {
  margin: 16px 0 0;
  font-size: 13px;
  opacity: 0.88;

  a,
  strong {
    font-weight: 600;
  }
}

.date-count {
  margin: 2px 0 0;
  font-size: 12px;
  opacity: 0.68;
}

.description-preview {
  display: -webkit-box;
  overflow: hidden;
  max-width: 720px;
  margin: 18px 0 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  font-size: 12px;
  line-height: 20px;
  text-align: left;
  opacity: 0.68;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;

  &:hover {
    opacity: 0.88;
  }
}

.header-actions {
  position: relative;
  display: flex;
  margin-top: 22px;
  align-items: center;
  gap: 6px;
}

.primary-action {
  display: inline-flex;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  align-items: center;
  gap: 6px;
  color: var(--color-text);
  background: var(--color-primary-bg-for-transparent);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  transition:
    background-color var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-out);

  .app-icon {
    width: 16px;
    height: 16px;
  }
  &:hover:not(:disabled) {
    background: var(--color-interactive-pressed);
  }
  &:active:not(:disabled) {
    transform: scale(0.98);
  }
  &:disabled {
    opacity: 0.48;
  }
  &.neutral {
    color: var(--color-text-secondary);
    background: transparent;
  }
}

.menu-anchor {
  position: relative;

  :deep(.icon-button.active) {
    color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
  }
}

.action-menu {
  position: absolute;
  z-index: var(--z-menu);
  top: 44px;
  left: 0;
  width: 220px;
  overflow: hidden;
  padding: 6px;
  border: 0.5px solid var(--floating-border);
  border-radius: var(--floating-radius);
  background: var(--floating-surface);
  box-shadow: var(--floating-shadow);
  backdrop-filter: saturate(160%) blur(28px);
  --floating-origin: top left;

  button {
    display: flex;
    width: 100%;
    min-height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    align-items: center;
    gap: 10px;
    color: var(--color-text-secondary);
    background: transparent;
    text-align: left;

    font-size: 13px;
    transition:
      color 140ms ease,
      background-color 140ms ease;

    &:hover,
    &:focus-visible {
      color: var(--color-text);
      background: var(--floating-item-hover);
    }
    .app-icon {
      width: 15px;
      height: 15px;
    }
  }
}

.playlist-search {
  position: absolute;
  right: 20px;
  bottom: -55px;
  display: flex;
  width: 200px;
  height: 32px;
  padding: 0 8px;
  border: 0.5px solid var(--floating-border);
  border-radius: var(--floating-dialog-radius);
  align-items: center;
  gap: 6px;
  color: var(--color-primary);
  background: var(--color-primary-bg-for-transparent);

  .app-icon {
    width: 15px;
    height: 15px;
  }
  input {
    width: 100%;
    min-width: 0;
    border: 0;
    color: inherit;
    background: transparent;
    font-size: 16px;
    font-weight: 600;
  }
}

.special-playlist {
  position: relative;
  margin: 128px 0 96px;
  text-align: center;

  h1 {
    margin: 0;
    font-size: 46px;
    line-height: 1.05;
    letter-spacing: 0;
    text-transform: uppercase;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  p {
    margin: 28px 0 0;
    font-size: 15px;
    letter-spacing: 0;
    text-transform: uppercase;
  }
  .header-actions {
    justify-content: center;
  }
  .action-menu {
    left: 50%;
    transform: translateX(-50%);
  }
}

.special-search {
  right: 50%;
  bottom: -60px;
  transform: translateX(50%);
}

.gradient-radar {
  background-image: linear-gradient(135deg, #6e9e75, #245c47);
}
.gradient-blue-purple {
  background-image: linear-gradient(135deg, #7da8a1, #304e51);
}
.gradient-sharp-blue {
  background-image: linear-gradient(135deg, #6996a5, #2d5965);
}
.gradient-yellow-pink {
  background-image: linear-gradient(135deg, #d0a26d, #875b46);
}
.gradient-pink {
  background-image: linear-gradient(135deg, #c5919b, #865a62);
}
.gradient-indigo-pink-yellow {
  background-image: linear-gradient(135deg, #587681, #8c7862 52%, #c1a16c);
}
.gradient-light-red-light-blue {
  background-image: linear-gradient(135deg, #87999a, #466064 48%, #925e56);
}
.gradient-fog {
  background-image: linear-gradient(135deg, #d1d8cf, #88958d);
}
.gradient-sky-blue {
  background-image: linear-gradient(135deg, #7cb6b8, #3e7277);
}
.gradient-dark-blue-midnight-blue {
  background-image: linear-gradient(135deg, #304b50, #1e302f);
}
.gradient-yellow-red {
  background-image: linear-gradient(135deg, #c2a264, #875544);
}
.gradient-yellow {
  background-image: linear-gradient(135deg, #dbba60, #a1763b);
}
.gradient-midnight-blue {
  background-image: linear-gradient(135deg, #405b5f, #263638);
}
.gradient-orange-red {
  background-image: linear-gradient(135deg, #c99b4e, #8a5440);
}
.gradient-moonstone-blue {
  background-image: linear-gradient(135deg, #1d3535, #4f7273 52%, #294746);
}
.gradient-pink-purple-blue {
  background-image: linear-gradient(135deg, #987785, #5b6f77 50%, #3d6669);
}
.gradient-green {
  background-image: linear-gradient(135deg, #aec1a6, #6e9977 55%, #427161);
}

.center-state {
  display: flex;
  min-height: 280px;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  opacity: 0.48;
}

.request-error {
  flex-direction: column;
  gap: 14px;
  color: var(--color-danger);
  opacity: 1;
}
.request-error button {
  min-height: 38px;
  padding: 0 16px;
  border: 1px solid currentColor;
  border-radius: 8px;
  color: inherit;
  background: transparent;
}
.feedback {
  margin: -48px 0 32px;
  text-align: center;
  color: var(--color-primary);
}
.feedback.error {
  color: var(--color-danger);
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

.modal-backdrop {
  position: fixed;
  z-index: var(--z-overlay);
  inset: 0;
  display: grid;
  padding: 32px;
  place-items: center;
  background: var(--color-overlay-scrim);
  backdrop-filter: blur(12px);
}

.mutation-dialog {
  width: min(440px, 100%);
  padding: 22px;
  border: 0.5px solid var(--floating-border);
  border-radius: var(--floating-dialog-radius);
  color: var(--color-text);
  background: var(--floating-surface);
  box-shadow: var(--floating-dialog-shadow);
  backdrop-filter: saturate(160%) blur(30px);

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    letter-spacing: -0.02em;
  }
}

.mutation-field {
  display: block;
  margin-top: 18px;

  input,
  textarea {
    width: 100%;
    border: 0.5px solid var(--floating-border);
    border-radius: 10px;
    color: var(--color-text);
    background: var(--color-surface-low);
    font: inherit;
    outline: none;
    transition:
      border-color 140ms ease,
      box-shadow 140ms ease;

    &:focus {
      border-color: color-mix(in srgb, var(--color-primary) 55%, var(--floating-border));
      box-shadow: 0 0 0 3px var(--color-primary-bg-for-transparent);
    }
  }

  input {
    height: 38px;
    padding: 0 11px;
  }

  textarea {
    min-height: 112px;
    padding: 10px 11px;
    resize: vertical;
  }
}

.mutation-message {
  margin: 18px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.55;
}

.mutation-actions {
  display: flex;
  margin-top: 22px;
  justify-content: flex-end;
  gap: 8px;

  button {
    min-width: 72px;
    height: 32px;
    padding: 0 14px;
    border: 0;
    border-radius: 999px;
    color: var(--color-text);
    background: var(--color-surface-low);
    font-size: 12px;
    font-weight: 650;

    &:hover:not(:disabled) {
      background: var(--floating-item-hover);
    }

    &:active:not(:disabled) {
      transform: scale(0.97);
    }

    &:disabled {
      opacity: 0.45;
    }

    &:last-child {
      color: var(--color-on-primary);
      background: var(--color-primary);
    }

    &.danger {
      background: var(--color-danger);
    }
  }
}

@media (max-width: 1080px) {
  .liked-songs-header {
    align-items: flex-start;
    flex-direction: column;

    h1 {
      font-size: 28px;
    }
  }

  .liked-search-input {
    width: min(172px, calc(100vw - 144px));
  }

  .playlist-header {
    min-height: 190px;
  }
  .cover-button {
    width: 190px;
    height: 190px;
    flex-basis: 190px;
  }
  .playlist-copy {
    margin-left: 28px;
  }
  .playlist-copy h1 {
    font-size: 27px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cover-play,
  .primary-action,
  .spinner {
    transition: none;
    animation: none;
  }
}
</style>
