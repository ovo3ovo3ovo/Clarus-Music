<template>
  <section class="music-video-view" :aria-busy="loading">
    <div v-if="loading" class="center-state" role="status">{{ t('musicVideo.loading') }}</div>
    <div v-else-if="loadError" class="center-state request-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" @click="loadDetail">{{ t('musicVideo.retry') }}</button>
    </div>

    <div v-show="detail" class="video-shell">
      <video ref="videoElement" class="plyr" playsinline></video>
    </div>

    <template v-if="detail && !loading && !loadError">
      <div class="video-info">
        <div class="title-row">
          <h1>
            <RouterLink :to="`/artist/${detail.artistId}`">{{ detail.artistName }}</RouterLink>
            <span aria-hidden="true"> - </span>
            <span>{{ detail.name }}</span>
          </h1>
          <div class="actions">
            <button
              class="icon-action"
              type="button"
              :title="t(detail.subscribed ? 'musicVideo.saved' : 'musicVideo.save')"
              :aria-label="t(detail.subscribed ? 'musicVideo.saved' : 'musicVideo.save')"
              :aria-pressed="detail.subscribed"
              :disabled="subscriptionBusy"
              @click="toggleSubscription"
            >
              <AppIcon :name="detail.subscribed ? 'heart-solid' : 'heart'" />
            </button>
            <div ref="menuRoot" class="menu-anchor">
              <IconButton
                icon="more"
                :title="t('musicVideo.more')"
                :class="{ active: menuOpen }"
                @click.stop="menuOpen = !menuOpen"
              />
              <Transition name="floating-menu">
                <div v-if="menuOpen" class="action-menu" role="menu">
                  <button type="button" role="menuitem" @click="copyVideoUrl">
                    <AppIcon name="list" />
                    <span>{{ t('musicVideo.copyLink') }}</span>
                  </button>
                  <button type="button" role="menuitem" @click="openVideoInBrowser">
                    <AppIcon name="arrow-up-alt" />
                    <span>{{ t('musicVideo.openBrowser') }}</span>
                  </button>
                </div>
              </Transition>
            </div>
          </div>
        </div>
        <p>
          {{ formatPlayCount(detail.playCount, locale) }} {{ t('musicVideo.views') }} ·
          {{ detail.publishTime }}
        </p>
      </div>

      <p v-if="feedback" class="feedback" role="status">{{ feedback }}</p>
      <p v-if="operationError" class="feedback error" role="alert">{{ operationError }}</p>

      <section v-if="detail.similarVideos.length" class="more-videos">
        <h2>{{ t('musicVideo.moreVideos') }}</h2>
        <MusicVideoGrid :items="detail.similarVideos" />
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Plyr from 'plyr'
import plyrStylesheet from 'plyr/dist/plyr.css?raw'
import { parsePositiveIntegerRouteParam } from '@/app/route-params'
import AppIcon from '@/components/common/AppIcon.vue'
import IconButton from '@/components/common/IconButton.vue'
import { useAuthStore } from '@/features/auth/application/auth-store'
import MusicVideoGrid from '@/features/catalog/presentation/MusicVideoGrid.vue'
import { usePlayerStore } from '@/features/player/application/player-store'
import { coverImageUrl } from '@/platform/cover-image'
import { externalLinkGateway } from '@/platform/external-links'
import { formatPlayCount, type MusicVideoDetail } from './domain/music-video'
import { NativeMusicVideoGateway } from './infrastructure/native-music-video'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const authStore = useAuthStore()
const audioPlayer = usePlayerStore()
const gateway = new NativeMusicVideoGateway()
const detail = shallowRef<MusicVideoDetail | null>(null)
const videoElement = ref<globalThis.HTMLVideoElement | null>(null)
const menuRoot = ref<globalThis.HTMLElement | null>(null)
const loading = ref(false)
const subscriptionBusy = ref(false)
const menuOpen = ref(false)
const loadError = shallowRef<string | null>(null)
const operationError = shallowRef<string | null>(null)
const feedback = shallowRef<string | null>(null)
let videoPlayer: Plyr | null = null
let detailController: AbortController | null = null
let subscriptionController: AbortController | null = null

const PLYR_STYLE_ELEMENT_ID = 'clarus-plyr-styles'
const compatiblePlyrStylesheet = plyrStylesheet.replace(
  '.plyr__ads::after:empty',
  '.plyr__ads:empty::after',
)

const videoId = computed(() => parsePositiveIntegerRouteParam(route.params.id))
const autoplay = computed(() => route.query.autoplay === 'true')

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function ensurePlyrStyles(): void {
  if (document.getElementById(PLYR_STYLE_ELEMENT_ID)) return
  const style = document.createElement('style')
  style.id = PLYR_STYLE_ELEMENT_ID
  style.textContent = compatiblePlyrStylesheet
  document.head.append(style)
}

function applyVideoSource(current: MusicVideoDetail): void {
  if (!videoPlayer) return
  videoPlayer.autoplay = autoplay.value
  videoPlayer.volume = audioPlayer.volume
  videoPlayer.source = {
    type: 'video',
    title: current.name,
    // A poster remains visible behind the native video decoder, so use the
    // bounded video policy instead of allocating a Retina 1920px bitmap.
    poster: coverImageUrl(current.coverUrl, 960, 540, { role: 'video' }),
    sources: current.sources.map((source) => ({
      src: source.url,
      type: source.mimeType,
      size: source.resolution,
    })),
  }
}

async function loadDetail(): Promise<void> {
  const id = videoId.value
  if (id === null) return
  detailController?.abort('Music video detail superseded')
  subscriptionController?.abort('Music video changed')
  detailController = null
  subscriptionController = null
  subscriptionBusy.value = false
  videoPlayer?.stop()
  detail.value = null
  loadError.value = null
  operationError.value = null
  feedback.value = null
  menuOpen.value = false
  const controller = new AbortController()
  detailController = controller
  loading.value = true
  try {
    const loaded = await gateway.detail(id, controller.signal)
    if (detailController !== controller) return
    detail.value = loaded
    await nextTick()
    if (detailController === controller) applyVideoSource(loaded)
  } catch (reason) {
    if (!isAbort(reason)) loadError.value = message(reason)
  } finally {
    if (detailController === controller) {
      detailController = null
      loading.value = false
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
  subscriptionController?.abort('Music video subscription superseded')
  const controller = new AbortController()
  subscriptionController = controller
  subscriptionBusy.value = true
  operationError.value = null
  feedback.value = null
  const subscribed = !current.subscribed
  try {
    await gateway.setSubscription(current.id, subscribed, controller.signal)
    if (subscriptionController !== controller) return
    detail.value = { ...current, subscribed }
    feedback.value = t(subscribed ? 'musicVideo.savedFeedback' : 'musicVideo.removedFeedback')
  } catch (reason) {
    if (!isAbort(reason)) operationError.value = message(reason)
  } finally {
    if (subscriptionController === controller) {
      subscriptionController = null
      subscriptionBusy.value = false
    }
  }
}

function videoUrl(): string {
  return `https://music.163.com/#/mv?id=${detail.value?.id ?? 0}`
}

async function copyVideoUrl(): Promise<void> {
  menuOpen.value = false
  try {
    await navigator.clipboard.writeText(videoUrl())
    feedback.value = t('musicVideo.copied')
  } catch (reason) {
    operationError.value = `${t('musicVideo.copyFailed')}: ${message(reason)}`
  }
}

async function openVideoInBrowser(): Promise<void> {
  menuOpen.value = false
  try {
    await externalLinkGateway.openNeteaseMusicVideo(detail.value?.id ?? 0)
  } catch (reason) {
    operationError.value = message(reason)
  }
}

function closeMenuOnOutsideClick(event: Event): void {
  if (!menuRoot.value?.contains(event.target as globalThis.Node)) menuOpen.value = false
}

function closeMenuOnEscape(event: globalThis.KeyboardEvent): void {
  if (event.key === 'Escape') menuOpen.value = false
}

function pauseAudioOnVideoPlayback(): void {
  if (!audioPlayer.playing) return
  void audioPlayer.togglePlayback().catch((reason: unknown) => {
    operationError.value = message(reason)
  })
}

watch(videoId, () => void loadDetail(), { immediate: true })
onMounted(() => {
  ensurePlyrStyles()
  if (videoElement.value) {
    videoPlayer = new Plyr(videoElement.value, {
      settings: ['quality'],
      autoplay: autoplay.value,
      quality: { default: 1080, options: [1080, 720, 480, 240] },
    })
    videoPlayer.volume = audioPlayer.volume
    videoPlayer.on('playing', pauseAudioOnVideoPlayback)
    videoPlayer.on('error', () => {
      operationError.value = t('musicVideo.playbackFailed')
    })
    if (detail.value) applyVideoSource(detail.value)
  }
  document.addEventListener('pointerdown', closeMenuOnOutsideClick)
  document.addEventListener('keydown', closeMenuOnEscape)
})
onBeforeUnmount(() => {
  detailController?.abort('Music video view disposed')
  subscriptionController?.abort('Music video view disposed')
  document.removeEventListener('pointerdown', closeMenuOnOutsideClick)
  document.removeEventListener('keydown', closeMenuOnEscape)
  videoPlayer?.destroy()
  videoPlayer = null
})
</script>

<style scoped lang="scss">
.music-video-view {
  min-height: calc(100vh - 160px);
  padding: 32px 0 40px;
  color: var(--color-text);
}

.video-shell {
  --plyr-color-main: var(--color-primary);
  --plyr-control-radius: 5px;
  --plyr-menu-background: var(--floating-surface);
  --plyr-menu-color: var(--color-text-secondary);
  --plyr-menu-shadow: var(--floating-shadow);
  --plyr-menu-arrow-color: var(--color-text-secondary);
  --plyr-menu-back-border-color: var(--floating-border);
  --plyr-menu-back-border-shadow-color: transparent;
  --plyr-tooltip-background: var(--floating-surface);
  --plyr-tooltip-color: var(--color-text);
  --plyr-tooltip-radius: 5px;
  --plyr-tooltip-shadow: var(--floating-shadow);

  width: 100%;
  max-height: calc(100vh - 330px);
  overflow: hidden;
  border-radius: 8px;
  background: #000;
  aspect-ratio: 16 / 9;

  :deep(.plyr),
  :deep(video) {
    width: 100%;
    height: 100%;
  }

  :deep(.plyr__menu__container) {
    overflow: hidden;
    border: 0.5px solid var(--floating-border);
    border-radius: var(--floating-radius);
    backdrop-filter: none;
  }

  :deep(.plyr__menu__container .plyr__control) {
    border-radius: 7px;
    transition:
      color 140ms ease,
      background-color 140ms ease;
  }

  :deep(.plyr__menu__container .plyr__control:hover),
  :deep(.plyr__menu__container .plyr__control.plyr__tab-focus) {
    color: var(--color-text);
    background: var(--floating-item-hover);
  }

  :deep(.plyr__menu__container .plyr__control[aria-checked='true']) {
    color: var(--color-primary);
  }

  :deep(.plyr__tooltip) {
    border: 0.5px solid var(--floating-border);
    backdrop-filter: none;
  }
}

.video-info {
  margin-top: 12px;

  > p {
    margin: 12px 0 0;
    font-size: 12px;
    opacity: 0.68;
  }
}

.title-row {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;

  h1 {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: 0;
  }
}

.actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
}

.icon-action {
  display: grid;
  position: relative;
  z-index: 0;
  width: 32px;
  height: 32px;
  padding: 8px;
  border: 0;
  border-radius: 5px;
  color: var(--color-primary);
  background: transparent;
  place-items: center;
  transform-origin: center;
  transition: transform var(--motion-hover-emphasis) var(--ease-out);

  .app-icon {
    width: 18px;
    height: 18px;
  }

  &:hover {
    background: transparent;
    transform: scale(var(--scale-hover-icon));
    z-index: 2;
  }

  &:focus-visible:not(:hover) {
    background: transparent;
    transform: none;
    z-index: 1;
    will-change: auto;
  }

  &:active:not(:disabled) {
    transform: scale(var(--scale-hover-icon));
  }
}

@media (prefers-reduced-motion: reduce) {
  .icon-action {
    transition: none;

    &:hover,
    &:focus-visible,
    &:active {
      transform: none;
      will-change: auto;
    }
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
  z-index: 20;
  top: 38px;
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

.more-videos {
  margin-top: 36px;

  h2 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0;
    opacity: 0.88;
  }
}

.feedback {
  margin: 12px 0 0;
  color: var(--color-primary);
  font-size: 11px;

  &.error {
    color: var(--color-danger);
  }
}

.center-state {
  display: grid;
  min-height: 360px;
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
  .video-shell {
    max-height: calc(100vh - 330px);
  }
}
</style>
