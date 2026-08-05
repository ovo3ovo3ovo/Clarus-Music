<template>
  <section class="artist-view" :aria-busy="loading">
    <ContentLoadingVeil
      v-if="loading"
      :label="t('artist.loading')"
      min-height="clamp(280px, 42vh, 420px)"
    />

    <div v-else-if="loadError" class="center-state request-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" @click="loadDetail">{{ t('artist.retry') }}</button>
    </div>

    <template v-else-if="detail">
      <header class="artist-header">
        <CoverImage
          :source="detail.artist.coverUrl"
          :width="512"
          :alt="detail.artist.name"
          decoding="async"
        />
        <div class="artist-copy">
          <h1>{{ detail.artist.name }}</h1>
          <p class="kind">{{ t('artist.artist') }}</p>
          <p class="statistics">
            <button type="button" @click="scrollTo(popularSection)">
              {{ detail.artist.musicCount }} {{ t('artist.songs') }}
            </button>
            <span> · </span>
            <button type="button" @click="scrollTo(albumsSection, 'start')">
              {{ detail.artist.albumCount }} {{ t('artist.albumsCount') }}
            </button>
            <span> · </span>
            <button type="button" @click="scrollTo(videosSection)">
              {{ detail.artist.videoCount }} {{ t('artist.videos') }}
            </button>
          </p>
          <button
            v-if="detail.artist.briefDescription"
            class="description-preview"
            type="button"
            @click="descriptionOpen = true"
          >
            <span>{{ detail.artist.briefDescription }}</span>
          </button>
          <div class="header-actions">
            <button class="primary-action" type="button" :disabled="busy" @click="playFirst">
              <AppIcon name="play" />
              <span>{{ t('artist.play') }}</span>
            </button>
            <button
              class="follow-action"
              type="button"
              :class="{ followed: detail.artist.followed }"
              :disabled="subscriptionBusy"
              @click="toggleSubscription"
            >
              {{ t(detail.artist.followed ? 'artist.following' : 'artist.follow') }}
            </button>
            <div ref="menuRoot" class="menu-anchor">
              <IconButton
                icon="more"
                :title="t('artist.more')"
                :class="{ active: menuOpen }"
                @click.stop="menuOpen = !menuOpen"
              />
              <Transition name="floating-menu">
                <div v-if="menuOpen" class="action-menu" role="menu">
                  <button type="button" role="menuitem" @click="copyArtistUrl">
                    <AppIcon name="list" />
                    <span>{{ t('artist.copyLink') }}</span>
                  </button>
                  <button type="button" role="menuitem" @click="openArtistInBrowser">
                    <AppIcon name="arrow-up-alt" />
                    <span>{{ t('artist.openBrowser') }}</span>
                  </button>
                </div>
              </Transition>
            </div>
          </div>
        </div>
      </header>

      <p v-if="feedback" class="feedback" role="status">{{ feedback }}</p>
      <p v-if="operationError" class="feedback error" role="alert">{{ operationError }}</p>

      <section v-if="detail.latestRelease" class="content-section latest-release">
        <h2>{{ t('artist.latestRelease') }}</h2>
        <div class="release-row">
          <article class="release-item">
            <RouterLink class="release-cover square" :to="`/album/${detail.latestRelease.id}`">
              <CoverImage
                :source="detail.latestRelease.coverUrl"
                :width="256"
                :alt="detail.latestRelease.name"
                loading="lazy"
                decoding="async"
              />
            </RouterLink>
            <div class="release-copy">
              <RouterLink :to="`/album/${detail.latestRelease.id}`">
                {{ detail.latestRelease.name }}
              </RouterLink>
              <span>{{ formatDate(detail.latestRelease.publishTime) }}</span>
              <small>
                {{ formatArtistAlbumType(detail.latestRelease) }} ·
                {{ detail.latestRelease.trackCount }} {{ t('artist.songs') }}
              </small>
            </div>
          </article>
          <article v-if="latestVideo" class="release-item">
            <RouterLink class="release-cover video" :to="`/mv/${latestVideo.id}`">
              <CoverImage
                :source="latestVideo.coverUrl"
                :width="464"
                :height="260"
                :alt="latestVideo.name"
                loading="lazy"
                decoding="async"
              />
            </RouterLink>
            <div class="release-copy">
              <RouterLink :to="`/mv/${latestVideo.id}`">{{ latestVideo.name }}</RouterLink>
              <span>{{ latestVideo.publishTime }}</span>
              <small>{{ t('artist.latestVideo') }}</small>
            </div>
          </article>
        </div>
      </section>

      <section ref="popularSection" class="content-section popular-tracks">
        <h2>{{ t('artist.popularSongs') }}</h2>
        <VirtualTrackList
          :tracks="visiblePopularTracks"
          :current-track-id="player.currentTrack?.id ?? null"
          :pending-track-id="player.pendingTrack?.id ?? null"
          :busy-track-id="busyTrackId"
          @play="playTrack"
        />
        <button
          v-if="detail.popularTracks.length > 12"
          class="show-more"
          type="button"
          @click="showMorePopular = !showMorePopular"
        >
          {{ t(showMorePopular ? 'artist.showLess' : 'artist.showMore') }}
        </button>
      </section>

      <section v-if="detail.albums.length" ref="albumsSection" class="content-section">
        <h2>{{ t('artist.albums') }}</h2>
        <ArtistAlbumGrid :albums="detail.albums" :busy-album-id="busyAlbumId" @play="playAlbum" />
      </section>

      <section v-if="detail.videos.length" ref="videosSection" class="content-section">
        <h2 class="section-heading">
          <span>{{ t('artist.musicVideos') }}</span>
          <RouterLink v-if="detail.videosHasMore" :to="`/artist/${detail.artist.id}/mv`">
            {{ t('artist.seeMore') }}
          </RouterLink>
        </h2>
        <ArtistVideoGrid :videos="detail.videos" />
      </section>

      <section v-if="detail.eps.length" class="content-section">
        <h2>{{ t('artist.epsSingles') }}</h2>
        <ArtistAlbumGrid
          :albums="detail.eps"
          :busy-album-id="busyAlbumId"
          subtitle-mode="albumTypeReleaseYear"
          @play="playAlbum"
        />
      </section>

      <section v-if="similarCards.length" class="content-section similar-artists">
        <h2>{{ t('artist.similarArtists') }}</h2>
        <ArtistList :artists="similarCards" />
      </section>
    </template>

    <DescriptionDialog
      :open="descriptionOpen && Boolean(detail)"
      :title="t('artist.descriptionTitle')"
      :close-label="t('artist.close')"
      :description="detail?.artist.briefDescription ?? ''"
      @close="descriptionOpen = false"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { parsePositiveIntegerRouteParam } from '@/app/route-params'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import ContentLoadingVeil from '@/components/common/ContentLoadingVeil.vue'
import DescriptionDialog from '@/components/common/DescriptionDialog.vue'
import IconButton from '@/components/common/IconButton.vue'
import { NativeAlbumGateway } from '@/features/album/infrastructure/native-album'
import { flattenAlbumTracks, selectAlbumTrack } from '@/features/album/domain/album'
import { useAuthStore } from '@/features/auth/application/auth-store'
import ArtistList from '@/features/catalog/presentation/ArtistList.vue'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import type { ArtistCard } from '@/features/catalog/domain/catalog'
import { releaseAudioSource } from '@/features/player/domain/audio-engine'
import { usePlayerStore } from '@/features/player/application/player-store'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import VirtualTrackList from '@/features/search/presentation/VirtualTrackList.vue'
import { externalLinkGateway } from '@/platform/external-links'
import type { Track } from '@/types/music'
import {
  formatArtistAlbumType,
  selectArtistTrack,
  type ArtistAlbum,
  type ArtistDetail,
} from './domain/artist'
import { NativeArtistGateway } from './infrastructure/native-artist'
import ArtistAlbumGrid from './presentation/ArtistAlbumGrid.vue'
import ArtistVideoGrid from './presentation/ArtistVideoGrid.vue'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const authStore = useAuthStore()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const artistGateway = new NativeArtistGateway()
const albumGateway = new NativeAlbumGateway()
const catalogGateway = new NativeCatalogGateway()
const detail = shallowRef<ArtistDetail | null>(null)
const loading = ref(false)
const busyTrackId = ref<number | null>(null)
const busyAlbumId = ref<number | null>(null)
const subscriptionBusy = ref(false)
const loadError = shallowRef<string | null>(null)
const operationError = shallowRef<string | null>(null)
const feedback = shallowRef<string | null>(null)
const showMorePopular = ref(false)
const descriptionOpen = ref(false)
const menuOpen = ref(false)
const menuRoot = ref<ReturnType<typeof document.querySelector>>(null)
const popularSection = ref<ReturnType<typeof document.querySelector>>(null)
const albumsSection = ref<ReturnType<typeof document.querySelector>>(null)
const videosSection = ref<ReturnType<typeof document.querySelector>>(null)
let detailController: AbortController | null = null
let playbackController: AbortController | null = null
let subscriptionController: AbortController | null = null

const artistId = computed(() => parsePositiveIntegerRouteParam(route.params.id))
const latestVideo = computed(() => detail.value?.videos[0] ?? null)
const visiblePopularTracks = computed(
  () => detail.value?.popularTracks.slice(0, showMorePopular.value ? 24 : 12) ?? [],
)
const busy = computed(
  () =>
    busyTrackId.value !== null ||
    busyAlbumId.value !== null ||
    !detail.value?.popularTracks.some((track) => track.playable),
)
const similarCards = computed<readonly ArtistCard[]>(() =>
  (detail.value?.similarArtists ?? []).map((artist) => ({
    kind: 'artist',
    ...artist,
    description: '',
  })),
)
const sourceKey = computed(() => `artist:${artistId.value ?? 0}`)

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(timestamp))
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

async function loadDetail(): Promise<void> {
  const id = artistId.value
  if (id === null) return
  detailController?.abort('Artist detail superseded')
  playbackController?.abort('Artist changed')
  subscriptionController?.abort('Artist changed')
  playbackController = null
  subscriptionController = null
  busyTrackId.value = null
  busyAlbumId.value = null
  subscriptionBusy.value = false
  const controller = new AbortController()
  detailController = controller
  detail.value = null
  loading.value = true
  loadError.value = null
  operationError.value = null
  feedback.value = null
  showMorePopular.value = false
  descriptionOpen.value = false
  menuOpen.value = false
  try {
    const loaded = await artistGateway.detail(id, controller.signal)
    if (detailController === controller) detail.value = loaded
  } catch (reason) {
    if (!isAbort(reason)) loadError.value = message(reason)
  } finally {
    if (detailController === controller) {
      detailController = null
      loading.value = false
    }
  }
}

async function loadSelection(
  selection: { readonly queue: readonly Track[]; readonly index: number; readonly track: Track },
  queueSource: string,
  controller: AbortController,
): Promise<void> {
  const source = await catalogGateway.resolveStream(
    selection.track.id,
    settingsStore.settings.musicQuality,
    controller.signal,
  )
  if (playbackController !== controller) {
    releaseAudioSource(source)
    return
  }
  player.setQueue(selection.queue, selection.index, queueSource)
  await player.load(selection.track, source, true, controller.signal)
}

async function playTrack(track: Track): Promise<void> {
  const current = detail.value
  if (!current) return
  const selection = selectArtistTrack(current.popularTracks, track.id)
  if (!selection) return
  playbackController?.abort('Artist playback superseded')
  const controller = new AbortController()
  playbackController = controller
  busyAlbumId.value = null
  busyTrackId.value = track.id
  operationError.value = null
  try {
    await loadSelection(selection, sourceKey.value, controller)
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
  const selection = detail.value && selectArtistTrack(detail.value.popularTracks)
  if (selection) void playTrack(selection.track)
}

async function playAlbum(album: ArtistAlbum): Promise<void> {
  playbackController?.abort('Artist album playback superseded')
  const controller = new AbortController()
  playbackController = controller
  busyTrackId.value = null
  busyAlbumId.value = album.id
  operationError.value = null
  try {
    const albumDetail = await albumGateway.detail(album.id, controller.signal)
    const selection = selectAlbumTrack(flattenAlbumTracks(albumDetail.discs))
    if (!selection) throw new Error(t('artist.noPlayableSongs'))
    await loadSelection(selection, `album:${album.id}`, controller)
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (playbackController === controller) {
      playbackController = null
      busyAlbumId.value = null
    }
  }
}

async function toggleSubscription(): Promise<void> {
  const current = detail.value
  if (!current || subscriptionBusy.value) return
  if (!authStore.session.authenticated) {
    await router.push('/login/account')
    return
  }
  subscriptionController?.abort('Artist subscription superseded')
  const controller = new AbortController()
  subscriptionController = controller
  subscriptionBusy.value = true
  operationError.value = null
  feedback.value = null
  const followed = !current.artist.followed
  try {
    await artistGateway.setSubscription(current.artist.id, followed, controller.signal)
    if (subscriptionController !== controller) return
    detail.value = { ...current, artist: { ...current.artist, followed } }
    feedback.value = t(followed ? 'artist.followed' : 'artist.unfollowed')
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (subscriptionController === controller) {
      subscriptionController = null
      subscriptionBusy.value = false
    }
  }
}

function scrollTo(
  element: ReturnType<typeof document.querySelector>,
  block: 'start' | 'center' | 'end' | 'nearest' = 'center',
): void {
  element?.scrollIntoView({ behavior: 'smooth', block })
}

function artistUrl(): string {
  return `https://music.163.com/#/artist?id=${detail.value?.artist.id ?? 0}`
}

async function copyArtistUrl(): Promise<void> {
  menuOpen.value = false
  try {
    await navigator.clipboard.writeText(artistUrl())
    feedback.value = t('artist.copied')
  } catch (reason) {
    operationError.value = `${t('artist.copyFailed')}: ${message(reason)}`
  }
}

async function openArtistInBrowser(): Promise<void> {
  menuOpen.value = false
  try {
    await externalLinkGateway.openNeteaseArtist(detail.value?.artist.id ?? 0)
  } catch (reason) {
    operationError.value = message(reason)
  }
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
}

watch(artistId, () => void loadDetail(), { immediate: true })
onMounted(() => {
  document.addEventListener('pointerdown', closeMenuOnOutsideClick)
  document.addEventListener('keydown', closeTransientUi)
})
onBeforeUnmount(() => {
  detailController?.abort('Artist view disposed')
  playbackController?.abort('Artist view disposed')
  subscriptionController?.abort('Artist view disposed')
  document.removeEventListener('pointerdown', closeMenuOnOutsideClick)
  document.removeEventListener('keydown', closeTransientUi)
})
</script>

<style scoped lang="scss">
.artist-view {
  min-height: calc(100vh - 160px);
  color: var(--color-text);
}

.artist-header {
  display: flex;
  min-height: 220px;
  margin-bottom: 24px;
  align-items: center;

  > img {
    width: 220px;
    height: 220px;
    margin-right: 40px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    object-fit: cover;
  }
}

.artist-copy {
  min-width: 0;
  flex: 1;

  h1 {
    margin: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-display);
    font-size: clamp(32px, 3.4vw, 48px);
    line-height: 0.98;
    letter-spacing: -0.06em;
  }
}

.kind {
  margin: 16px 0 0;
  font-size: 13px;
  opacity: 0.88;
}

.statistics {
  margin: 2px 0 0;
  font-size: 12px;
  opacity: 0.68;

  button {
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;

    &:hover {
      text-decoration: underline;
    }
  }
}

.description-preview {
  display: block;
  width: min(100%, 620px);
  margin-top: 18px;
  padding: 0;
  border: 0;
  color: var(--color-text);
  text-align: left;
  background: transparent;
  opacity: 0.68;

  span {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    line-height: 1.5;
    -webkit-line-clamp: 2;
    white-space: pre-line;
  }
}

.header-actions {
  display: flex;
  margin-top: 20px;
  align-items: center;
  gap: 6px;
}

.primary-action,
.follow-action {
  display: inline-flex;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
}

.primary-action {
  min-width: 0;
  color: var(--color-text);
  background: var(--color-primary-bg-for-transparent);
  transition:
    background-color var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-out);

  .app-icon {
    width: 15px;
    height: 15px;
  }

  &:hover:not(:disabled) {
    background: var(--color-interactive-pressed);
  }

  &:active:not(:disabled) {
    transform: scale(0.98);
  }
}

.follow-action {
  color: var(--color-text-secondary);
  background: transparent;
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-out);

  &:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-interactive-hover);
    transform: scale(0.98);
  }

  &.followed {
    color: var(--color-primary);
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
  top: 42px;
  right: 0;
  width: 220px;
  padding: 6px;
  border: 0.5px solid var(--floating-border);
  border-radius: var(--floating-radius);
  background: var(--floating-surface);
  box-shadow: var(--floating-shadow);
  backdrop-filter: saturate(160%) blur(28px);
  --floating-origin: top right;

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
    font-size: 13px;
    text-align: left;
    background: transparent;

    transition:
      color 140ms ease,
      background-color 140ms ease;

    &:hover,
    &:focus-visible {
      color: var(--color-text);
      background: var(--floating-item-hover);
    }
  }
}

.feedback {
  margin: 0 0 14px;
  color: var(--color-primary);
  font-size: 14px;

  &.error {
    color: var(--color-danger);
  }
}

.content-section {
  padding-top: 46px;

  > h2 {
    margin: 0 0 16px;
    color: var(--color-text);
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0;
    opacity: 0.88;
  }
}

.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;

  a {
    color: var(--color-text);
    font-size: 11px;
    font-weight: 600;
    opacity: 0.68;
  }
}

.release-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.release-item {
  position: relative;
  z-index: 0;
  display: flex;
  min-width: 0;
  align-items: center;
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

.release-cover {
  display: block;
  width: 128px;
  height: 128px;
  flex: 0 0 128px;

  img {
    display: block;
    width: 100%;
    height: 100%;
    border: 1px solid rgb(0 0 0 / 5%);
    border-radius: 12px;
    object-fit: cover;
  }

  &.video {
    width: 228px;
    flex-basis: 228px;
  }
}

.release-copy {
  display: flex;
  min-width: 0;
  margin-left: 24px;
  flex-direction: column;

  a {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    color: var(--color-text);
    font-size: 15px;
    font-weight: 600;
    -webkit-line-clamp: 2;
  }

  span {
    margin-top: 8px;
    font-size: 12px;
    opacity: 0.78;
  }

  small {
    margin-top: 2px;
    font-size: 10px;
    opacity: 0.68;
  }
}

.show-more {
  margin-top: 8px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  color: var(--color-secondary);
  font-size: 12px;
  font-weight: 600;
  background: transparent;
  opacity: 0.78;
}

.similar-artists {
  padding-bottom: 36px;
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

@media (max-width: 1080px) {
  .artist-header > img {
    width: 180px;
    height: 180px;
    margin-right: 28px;
    flex-basis: 180px;
  }

  .artist-copy h1 {
    font-size: 29px;
  }

  .description-preview {
    margin-top: 16px;
  }

  .header-actions {
    margin-top: 20px;
  }

  .release-cover.video {
    width: 180px;
    flex-basis: 180px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .release-item {
    transition: none;
  }

  .release-item:hover,
  .release-item:focus-within,
  .release-item:active {
    transform: none;
  }
}
</style>
