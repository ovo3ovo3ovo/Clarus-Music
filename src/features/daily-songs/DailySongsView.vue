<template>
  <section class="daily-songs-view" :aria-busy="loading">
    <ContentLoadingVeil
      v-if="authStore.restoring || loading"
      :label="t('dailySongs.loading')"
      min-height="420px"
    />

    <div v-else-if="loadError" class="center-state" role="alert">
      <p>{{ loadError }}</p>
      <button type="button" @click="loadDailySongs">{{ t('dailySongs.retry') }}</button>
    </div>

    <template v-else-if="authStore.session.authenticated">
      <header class="daily-header">
        <h1>{{ t('dailySongs.title') }}</h1>
        <p>{{ t('dailySongs.subtitle') }}</p>
      </header>

      <VirtualTrackList
        v-if="tracks.length > 0"
        :tracks="tracks"
        :current-track-id="player.currentTrack?.id ?? null"
        :pending-track-id="player.pendingTrack?.id ?? null"
        :busy-track-id="busyTrackId"
        @play="playTrack"
      />
      <p v-else class="empty-state">{{ t('dailySongs.empty') }}</p>
      <p v-if="playbackError" class="playback-error" role="alert">{{ playbackError }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ContentLoadingVeil from '@/components/common/ContentLoadingVeil.vue'
import { useAuthStore } from '@/features/auth/application/auth-store'
import { NativeCatalogGateway } from '@/features/catalog/infrastructure/native-catalog'
import { usePlayerStore } from '@/features/player/application/player-store'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import VirtualTrackList from '@/features/search/presentation/VirtualTrackList.vue'
import type { Track } from '@/types/music'
import { selectDailySong } from './domain/daily-songs'
import { NativeDailySongsGateway } from './infrastructure/native-daily-songs'

const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const player = usePlayerStore()
const dailyGateway = new NativeDailySongsGateway()
const catalogGateway = new NativeCatalogGateway()
const tracks = shallowRef<readonly Track[]>([])
const loading = shallowRef(false)
const loadError = shallowRef<string | null>(null)
const playbackError = shallowRef<string | null>(null)
const busyTrackId = shallowRef<number | null>(null)
let loadController: AbortController | null = null
let playbackController: AbortController | null = null

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

async function loadDailySongs(): Promise<void> {
  loadController?.abort('Daily songs load superseded')
  playbackController?.abort('Daily songs reloaded')
  tracks.value = []
  loadError.value = null
  playbackError.value = null
  if (authStore.restoring) return
  if (!authStore.session.authenticated) {
    await router.replace('/login/account')
    return
  }
  const controller = new AbortController()
  loadController = controller
  loading.value = true
  try {
    tracks.value = (await dailyGateway.load(controller.signal)).tracks
  } catch (reason) {
    if (!isAbort(reason)) loadError.value = message(reason)
  } finally {
    if (loadController === controller) {
      loadController = null
      loading.value = false
    }
  }
}

async function playTrack(track: Track): Promise<void> {
  const selection = selectDailySong(tracks.value, track.id)
  if (!selection) return
  playbackController?.abort('Daily song selection superseded')
  const controller = new AbortController()
  playbackController = controller
  busyTrackId.value = track.id
  playbackError.value = null
  try {
    const source = await catalogGateway.resolveStream(
      track.id,
      settingsStore.settings.musicQuality,
      controller.signal,
    )
    if (playbackController !== controller) return
    player.setQueue(selection.queue, selection.index, 'daily:songs')
    await player.load(selection.track, source, true, controller.signal)
  } catch (reason) {
    if (!isAbort(reason)) playbackError.value = message(reason)
  } finally {
    if (playbackController === controller) {
      playbackController = null
      busyTrackId.value = null
    }
  }
}

watch(
  [() => authStore.restoring, () => authStore.session.authenticated],
  () => void loadDailySongs(),
  { immediate: true },
)

onBeforeUnmount(() => {
  loadController?.abort('Daily songs view disposed')
  playbackController?.abort('Daily songs view disposed')
})
</script>

<style scoped lang="scss">
.daily-songs-view {
  min-height: calc(100vh - 160px);
  color: var(--color-text);
}

.daily-header {
  margin: 0 0 28px;

  h1 {
    margin: 0;
    color: var(--color-text);
    font-size: 28px;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.045em;
  }

  p {
    margin: 7px 0 0;
    color: var(--color-text-secondary);
    font-size: 11px;
  }
}

.center-state,
.empty-state {
  min-height: 320px;
  text-align: center;
}

.center-state {
  display: grid;
  place-content: center;
  gap: 14px;

  p {
    margin: 0;
  }

  button {
    min-height: 30px;
    padding: 0 7px;
    border: 0;
    border-radius: 5px;
    color: var(--color-text-secondary);
    background: transparent;
    font-size: 12px;
    font-weight: var(--font-weight-medium);

    &:hover,
    &:focus-visible {
      color: var(--color-text);
      background: var(--color-interactive-hover);
    }
  }
}

.empty-state {
  margin: 0;
  padding-top: 56px;
  opacity: 0.58;
}

.playback-error {
  margin: 20px 0 0;
  color: var(--color-danger);
  text-align: center;
}
</style>
