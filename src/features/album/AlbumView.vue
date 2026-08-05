<template>
  <section class="album-view" :aria-busy="loading">
    <ContentLoadingVeil
      v-if="loading"
      :label="t('album.loading')"
      min-height="clamp(280px, 42vh, 420px)"
    />

    <div v-else-if="loadError" class="center-state request-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" @click="loadDetail">{{ t('album.retry') }}</button>
    </div>

    <template v-else-if="detail">
      <header class="album-header">
        <button
          class="cover-button"
          type="button"
          :title="t('album.play')"
          :disabled="busy"
          @click="playFirst"
        >
          <span class="cover-shadow" :style="coverStyle"></span>
          <CoverImage :source="detail.coverUrl" :width="1024" :alt="detail.name" decoding="async" />
          <span class="cover-play"><AppIcon name="play" /></span>
        </button>

        <div class="album-copy">
          <h1>{{ albumTitle.title }}</h1>
          <p v-if="albumTitle.subtitle" class="subtitle">{{ albumTitle.subtitle }}</p>
          <p class="artist">
            <template v-if="detail.artist.id === 104700">
              {{ t('album.compilation') }}
            </template>
            <template v-else>
              {{ formatAlbumType(detail.albumType, detail.trackCount) }} {{ t('album.by') }}
              <RouterLink :to="`/artist/${detail.artist.id}`">{{ detail.artist.name }}</RouterLink>
            </template>
          </p>
          <p class="date-count">
            <AppIcon v-if="detail.explicit" class="explicit" name="explicit" />
            <span :title="formattedReleaseDate">{{ releaseYear }}</span>
            <span> · {{ detail.trackCount }} {{ t('album.songs') }}, {{ humanDuration }}</span>
          </p>
          <button
            v-if="detail.description"
            class="description-preview"
            type="button"
            @click="descriptionOpen = true"
          >
            <span>{{ detail.description }}</span>
          </button>
          <div class="header-actions">
            <button class="primary-action" type="button" :disabled="busy" @click="playFirst">
              <AppIcon name="play" />
              <span>{{ t('album.play') }}</span>
            </button>
            <IconButton
              :icon="detail.subscribed ? 'heart-solid' : 'heart'"
              :title="t(detail.subscribed ? 'album.remove' : 'album.save')"
              :disabled="subscriptionBusy"
              @click="toggleSubscription"
            />
            <div ref="menuRoot" class="menu-anchor">
              <IconButton
                icon="more"
                :title="t('album.more')"
                :class="{ active: menuOpen }"
                @click.stop="menuOpen = !menuOpen"
              />
              <Transition name="floating-menu">
                <div v-if="menuOpen" class="action-menu" role="menu">
                  <button type="button" role="menuitem" @click="toggleSubscription">
                    <AppIcon :name="detail.subscribed ? 'heart-solid' : 'heart'" />
                    <span>{{ t(detail.subscribed ? 'album.remove' : 'album.save') }}</span>
                  </button>
                  <button type="button" role="menuitem" @click="copyAlbumUrl">
                    <AppIcon name="list" />
                    <span>{{ t('album.copyLink') }}</span>
                  </button>
                  <button type="button" role="menuitem" @click="openAlbumInBrowser">
                    <AppIcon name="arrow-up-alt" />
                    <span>{{ t('album.openBrowser') }}</span>
                  </button>
                </div>
              </Transition>
            </div>
          </div>
        </div>
      </header>

      <p v-if="feedback" class="feedback" role="status">{{ feedback }}</p>
      <p v-if="operationError" class="feedback error" role="alert">{{ operationError }}</p>

      <div v-if="detail.discs.length > 1" class="disc-lists">
        <section v-for="disc in detail.discs" :key="disc.disc" class="disc-section">
          <h2>{{ t('album.disc') }} {{ disc.disc }}</h2>
          <VirtualTrackList
            :tracks="disc.tracks"
            :current-track-id="player.currentTrack?.id ?? null"
            :pending-track-id="player.pendingTrack?.id ?? null"
            :busy-track-id="busyTrackId"
            show-explicit-after-title
            @play="playTrack"
          />
        </section>
      </div>
      <VirtualTrackList
        v-else-if="tracks.length"
        :tracks="tracks"
        :current-track-id="player.currentTrack?.id ?? null"
        :pending-track-id="player.pendingTrack?.id ?? null"
        :busy-track-id="busyTrackId"
        show-explicit-after-title
        @play="playTrack"
      />
      <div v-else class="center-state">{{ t('album.noTracks') }}</div>

      <footer class="album-extra">
        <p>{{ t('album.released') }} {{ formattedReleaseDate }}</p>
        <p v-if="detail.company">© {{ detail.company }}</p>
      </footer>

      <section v-if="detail.artist.id !== 104700" class="more-by">
        <h2>
          {{ t('album.moreBy') }}
          <RouterLink :to="`/artist/${detail.artist.id}`">{{ detail.artist.name }}</RouterLink>
        </h2>
        <CatalogCoverGrid v-if="detail.moreAlbums.length" :items="detail.moreAlbums" />
        <div v-else class="related-albums-empty" aria-live="polite">
          <AppIcon name="album" />
          <div>
            <p>{{ t('album.noRelatedAlbums') }}</p>
            <span>{{ t('album.noRelatedAlbumsHint') }}</span>
          </div>
        </div>
      </section>
    </template>

    <DescriptionDialog
      :open="descriptionOpen && Boolean(detail)"
      :title="t('album.descriptionTitle')"
      :close-label="t('album.close')"
      :description="detail?.description ?? ''"
      @close="descriptionOpen = false"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import ContentLoadingVeil from '@/components/common/ContentLoadingVeil.vue'
import DescriptionDialog from '@/components/common/DescriptionDialog.vue'
import IconButton from '@/components/common/IconButton.vue'
import { parsePositiveIntegerRouteParam } from '@/app/route-params'
import { useAuthStore } from '@/features/auth/application/auth-store'
import CatalogCoverGrid from '@/features/catalog/presentation/CatalogCoverGrid.vue'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import { releaseAudioSource } from '@/features/player/domain/audio-engine'
import { usePlayerStore } from '@/features/player/application/player-store'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import VirtualTrackList from '@/features/search/presentation/VirtualTrackList.vue'
import { coverImageUrl } from '@/platform/cover-image'
import { externalLinkGateway } from '@/platform/external-links'
import type { Track } from '@/types/music'
import {
  flattenAlbumTracks,
  formatAlbumType,
  selectAlbumTrack,
  splitAlbumTitle,
  type AlbumDetail,
} from './domain/album'
import { NativeAlbumGateway } from './infrastructure/native-album'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const authStore = useAuthStore()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const albumGateway = new NativeAlbumGateway()
const catalogGateway = new NativeCatalogGateway()
const detail = shallowRef<AlbumDetail | null>(null)
const loading = ref(false)
const busyTrackId = ref<number | null>(null)
const subscriptionBusy = ref(false)
const loadError = shallowRef<string | null>(null)
const operationError = shallowRef<string | null>(null)
const feedback = shallowRef<string | null>(null)
const descriptionOpen = ref(false)
const menuOpen = ref(false)
const menuRoot = ref<ReturnType<typeof document.querySelector> | null>(null)
let detailController: AbortController | null = null
let playbackController: AbortController | null = null
let subscriptionController: AbortController | null = null

const albumId = computed(() => parsePositiveIntegerRouteParam(route.params.id))
const tracks = computed(() => (detail.value ? flattenAlbumTracks(detail.value.discs) : []))
const albumTitle = computed(() => splitAlbumTitle(detail.value?.name ?? ''))
const sourceKey = computed(() => `album:${albumId.value ?? 0}`)
const coverUrl = computed(() => imageUrl(detail.value?.coverUrl ?? '', 1024))
const coverStyle = computed(() => ({ '--cover-image': `url(${JSON.stringify(coverUrl.value)})` }))
const busy = computed(
  () => busyTrackId.value !== null || tracks.value.every((track) => !track.playable),
)
const formattedReleaseDate = computed(() =>
  new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long', day: 'numeric' }).format(
    new Date(detail.value?.publishTime ?? 0),
  ),
)
const releaseYear = computed(() => new Date(detail.value?.publishTime ?? 0).getFullYear())
const humanDuration = computed(() => {
  const minutes = Math.max(0, Math.floor((detail.value?.durationMs ?? 0) / 60_000))
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return [
    hours > 0 ? t('album.hours', { count: hours }) : '',
    t('album.minutes', { count: remainder }),
  ]
    .filter(Boolean)
    .join(' ')
})

function imageUrl(source: string, size: number): string {
  return coverImageUrl(source, size)
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

async function loadDetail(): Promise<void> {
  const id = albumId.value
  if (id === null) return
  detailController?.abort('Album detail superseded')
  playbackController?.abort('Album changed')
  subscriptionController?.abort('Album changed')
  const controller = new AbortController()
  detailController = controller
  detail.value = null
  loading.value = true
  loadError.value = null
  operationError.value = null
  feedback.value = null
  descriptionOpen.value = false
  menuOpen.value = false
  try {
    const loaded = await albumGateway.detail(id, controller.signal)
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

async function playTrack(track: Track): Promise<void> {
  const selection = selectAlbumTrack(tracks.value, track.id)
  if (!selection) return
  playbackController?.abort('Album track selection superseded')
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
  const selection = selectAlbumTrack(tracks.value)
  if (selection) void playTrack(selection.track)
}

async function toggleSubscription(): Promise<void> {
  const current = detail.value
  menuOpen.value = false
  if (!current || subscriptionBusy.value) return
  if (!authStore.session.authenticated) {
    await router.push('/login/account')
    return
  }
  subscriptionController?.abort('Album subscription superseded')
  const controller = new AbortController()
  subscriptionController = controller
  subscriptionBusy.value = true
  operationError.value = null
  feedback.value = null
  const subscribed = !current.subscribed
  try {
    await albumGateway.setSubscription(current.id, subscribed, controller.signal)
    if (subscriptionController !== controller) return
    detail.value = { ...current, subscribed }
    feedback.value = t(subscribed ? 'album.saved' : 'album.removed')
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (subscriptionController === controller) {
      subscriptionController = null
      subscriptionBusy.value = false
    }
  }
}

function albumUrl(): string {
  return `https://music.163.com/#/album?id=${detail.value?.id ?? 0}`
}

async function copyAlbumUrl(): Promise<void> {
  menuOpen.value = false
  try {
    await navigator.clipboard.writeText(albumUrl())
    feedback.value = t('album.copied')
  } catch (reason) {
    operationError.value = `${t('album.copyFailed')}: ${message(reason)}`
  }
}

async function openAlbumInBrowser(): Promise<void> {
  menuOpen.value = false
  try {
    await externalLinkGateway.openNeteaseAlbum(detail.value?.id ?? 0)
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

watch(albumId, () => void loadDetail(), { immediate: true })
onMounted(() => {
  document.addEventListener('pointerdown', closeMenuOnOutsideClick)
  document.addEventListener('keydown', closeTransientUi)
})
onBeforeUnmount(() => {
  detailController?.abort('Album view disposed')
  playbackController?.abort('Album view disposed')
  subscriptionController?.abort('Album view disposed')
  document.removeEventListener('pointerdown', closeMenuOnOutsideClick)
  document.removeEventListener('keydown', closeTransientUi)
})
</script>

<style scoped lang="scss">
.album-view {
  min-height: calc(100vh - 160px);
  color: var(--color-text);
}

.album-header {
  display: flex;
  width: min(100%, 1120px);
  min-height: 232px;
  margin-bottom: 48px;
  align-items: stretch;
}

.cover-button {
  position: relative;
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

  &:hover:not(:disabled) .cover-play,
  &:focus-visible .cover-play {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

.cover-shadow {
  position: absolute;
  z-index: 0;
  inset: 20px 14px -14px;
  border-radius: var(--radius-md);
  background: center / cover var(--cover-image);
  opacity: 0;
}

.cover-play {
  position: absolute;
  z-index: 2;
  top: 50%;
  left: 50%;
  display: grid;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 5px;
  color: var(--color-text);
  background: rgb(0 0 0 / 66%);
  opacity: 0;
  place-items: center;
  transform: translate(-50%, -50%) scale(0.88);
  transition:
    opacity 160ms ease,
    transform 160ms ease;

  .app-icon {
    width: 18px;
    height: 18px;
    margin-left: 2px;
  }
}

.album-copy {
  display: flex;
  min-width: 0;
  padding: 8px 0 6px 40px;
  flex: 1;
  flex-direction: column;
  justify-content: center;

  h1 {
    margin: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-display);
    font-size: clamp(32px, 3.4vw, 48px);
    line-height: 0.98;
    letter-spacing: -0.06em;
  }
}

.subtitle {
  margin: 5px 0 0;
  font-size: 15px;
  font-weight: 600;
}

.artist {
  margin: 16px 0 0;
  font-size: 13px;
  opacity: 0.88;

  a {
    font-weight: 600;
  }
}

.date-count {
  display: flex;
  margin: 2px 0 0;
  align-items: center;
  font-size: 12px;
  opacity: 0.68;
}

.explicit {
  width: 15px;
  height: 15px;
  margin-right: 4px;
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
    font-size: 12px;
    line-height: 1.5;
    -webkit-line-clamp: 3;
    white-space: pre-line;
  }
}

.header-actions {
  display: flex;
  margin-top: 20px;
  align-items: center;
  gap: 6px;
}

.primary-action {
  display: inline-flex;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-text);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
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
  margin: -42px 0 24px;
  color: var(--color-primary);
  font-size: 14px;

  &.error {
    color: var(--color-danger);
  }
}

.disc-section {
  margin-bottom: 24px;

  h2 {
    margin: 0 0 14px;
    font-size: 18px;
    letter-spacing: 0;
  }
}

.album-extra {
  margin: 36px 0;
  font-size: 12px;
  opacity: 0.48;

  p {
    margin: 0 0 4px;
  }
}

.more-by {
  padding-top: 22px;
  border-top: 1px solid rgb(128 128 128 / 18%);

  h2 {
    margin: 0 0 20px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0;
    opacity: 0.88;
  }
}

.related-albums-empty {
  display: grid;
  min-height: 156px;
  place-content: center;
  gap: 12px;
  color: var(--color-text-secondary);
  text-align: center;

  .app-icon {
    width: 28px;
    height: 28px;
    margin: 0 auto;
    opacity: 0.28;
  }

  p,
  span {
    display: block;
    margin: 0;
  }

  p {
    color: var(--color-text);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: -0.012em;
    opacity: 0.78;
  }

  span {
    margin-top: 5px;
    font-size: 12px;
    line-height: 1.45;
    opacity: 0.58;
  }
}

.center-state {
  display: grid;
  min-height: 240px;
  place-items: center;
  color: var(--color-text);
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
  .album-header {
    min-height: 190px;
  }

  .cover-button {
    width: 190px;
    height: 190px;
    flex-basis: 190px;
  }

  .album-copy {
    padding-left: 28px;

    h1 {
      font-size: 29px;
    }
  }

  .description-preview {
    margin-top: 16px;

    span {
      -webkit-line-clamp: 2;
    }
  }

  .header-actions {
    margin-top: 22px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cover-play {
    transition: none;
    animation: none;
  }
}
</style>
