<template>
  <Teleport to="body">
    <Transition name="floating-menu" appear>
      <div
        v-if="track && position"
        ref="menuRoot"
        class="track-context-menu"
        role="menu"
        :style="menuStyle"
        @pointerdown.stop
      >
        <button type="button" role="menuitem" :disabled="!track.playable" @click="play">
          <AppIcon name="play" />
          <span>{{ t('player.play') }}</span>
        </button>
        <button type="button" role="menuitem" :disabled="loading" @click="togglePlaylistPicker">
          <AppIcon name="plus" />
          <span>{{ t('player.addToPlaylist') }}</span>
        </button>
        <button type="button" role="menuitem" :disabled="likeBusy" @click="toggleLike">
          <AppIcon :name="likeState ? 'heart-solid' : 'heart'" />
          <span>{{ t(likeState ? 'player.unlike' : 'player.like') }}</span>
        </button>
        <button type="button" role="menuitem" :disabled="track.album.id <= 0" @click="openAlbum">
          <AppIcon name="arrow-right" />
          <span>{{ t('player.viewAlbum') }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!validArtists.length"
          @click="toggleArtistPicker"
        >
          <AppIcon name="arrow-right" />
          <span>{{ t('player.viewArtist') }}</span>
        </button>
        <Transition name="floating-menu">
          <div v-if="artistPickerOpen" class="artist-submenu" role="group">
            <button
              v-for="artist in validArtists"
              :key="artist.id"
              type="button"
              role="menuitem"
              @click="openArtist(artist.id)"
            >
              <span>{{ artist.name }}</span>
            </button>
          </div>
        </Transition>
        <button type="button" role="menuitem" :disabled="externalBusy" @click="openInBrowser">
          <AppIcon name="arrow-up-alt" />
          <span>{{ t('player.openInBrowser') }}</span>
        </button>
        <button type="button" role="menuitem" @click="copyTrackInfo">
          <AppIcon name="list" />
          <span>{{ t('player.copySongInfo') }}</span>
        </button>
        <button type="button" role="menuitem" @click="copyTrackLink">
          <AppIcon name="arrow-up-alt" />
          <span>{{ t('player.copySongLink') }}</span>
        </button>

        <Transition name="floating-menu">
          <div v-if="pickerOpen" class="playlist-submenu" role="group">
            <div v-if="loading" class="submenu-state" role="status">{{ t('player.loading') }}</div>
            <button
              v-for="playlist in playlists"
              v-else
              :key="playlist.id"
              type="button"
              role="menuitem"
              :disabled="mutationId !== null"
              @click="addToPlaylist(playlist.id)"
            >
              <span>{{ playlist.name }}</span>
              <span v-if="mutationId === playlist.id" class="spinner" aria-hidden="true"></span>
            </button>
            <div v-if="!loading && !playlists.length" class="submenu-state">
              {{ t('player.noPlaylists') }}
            </div>
          </div>
        </Transition>
        <p v-if="error" class="submenu-error" role="alert">{{ error }}</p>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import { useAuthStore } from '@/features/auth/application/auth-store'
import type { LibraryPlaylist } from '@/features/library/domain/library'
import { NativeLibraryGateway } from '@/features/library/infrastructure/native-library'
import { NativePlaylistGateway } from '@/features/playlist/infrastructure/native-playlist'
import { emitTrackLikeChange } from '@/features/player/application/track-like-events'
import { usePlayerStore } from '@/features/player/application/player-store'
import { NativeTrackLikeGateway } from '@/features/player/infrastructure/native-like'
import { externalLinkGateway } from '@/platform/external-links'
import { formatArtists } from '@/types/music'
import type { Track } from '@/types/music'

const props = defineProps<{
  track: Track | null
  position: { x: number; y: number } | null
}>()

const emit = defineEmits<{ close: []; play: [track: Track] }>()
const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()
const player = usePlayerStore()
const libraryGateway = new NativeLibraryGateway()
const playlistGateway = new NativePlaylistGateway()
const likeGateway = new NativeTrackLikeGateway()
const menuRoot = ref<globalThis.HTMLElement | null>(null)
const pickerOpen = shallowRef(false)
const artistPickerOpen = shallowRef(false)
const loading = shallowRef(false)
const error = shallowRef('')
const playlists = shallowRef<readonly LibraryPlaylist[]>([])
const mutationId = shallowRef<number | null>(null)
const likeState = shallowRef<boolean | null>(null)
const likeBusy = shallowRef(false)
const externalBusy = shallowRef(false)
let requestController: AbortController | null = null
let mutationController: AbortController | null = null
let likeController: AbortController | null = null

const menuStyle = computed(() => ({
  left: `${props.position?.x ?? 8}px`,
  top: `${props.position?.y ?? 8}px`,
}))
const validArtists = computed(() => {
  const unique = new Map<number, Track['artists'][number]>()
  for (const artist of props.track?.artists ?? []) {
    if (artist.id > 0 && !unique.has(artist.id)) unique.set(artist.id, artist)
  }
  return [...unique.values()]
})

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function close(): void {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  requestController?.abort('Track context menu closed')
  mutationController?.abort('Track context menu closed')
  likeController?.abort('Track context menu closed')
  requestController = null
  mutationController = null
  likeController = null
  pickerOpen.value = false
  artistPickerOpen.value = false
  loading.value = false
  mutationId.value = null
  likeBusy.value = false
  externalBusy.value = false
  error.value = ''
  emit('close')
}

function play(): void {
  if (props.track?.playable) emit('play', props.track)
  close()
}

async function loadLikeState(trackId: number): Promise<void> {
  likeController?.abort('Like state superseded')
  const controller = new AbortController()
  likeController = controller
  likeBusy.value = true
  try {
    const liked = await likeGateway.check(trackId, controller.signal)
    if (likeController === controller) likeState.value = liked
  } catch (reason) {
    if (!isAbort(reason) && likeController === controller) error.value = reasonMessage(reason)
  } finally {
    if (likeController === controller) {
      likeController = null
      likeBusy.value = false
    }
  }
}

async function toggleLike(): Promise<void> {
  const track = props.track
  if (!track) return
  if (!authStore.session.user) {
    close()
    await router.push('/login/account')
    return
  }
  likeController?.abort('Like mutation superseded')
  const controller = new AbortController()
  likeController = controller
  likeBusy.value = true
  error.value = ''
  try {
    const current = likeState.value ?? (await likeGateway.check(track.id, controller.signal))
    const liked = await likeGateway.setLiked(track.id, !current, controller.signal)
    if (likeController === controller) {
      likeState.value = liked
      player.syncLikeState(track.id, liked)
      emitTrackLikeChange({ track, liked })
      close()
    }
  } catch (reason) {
    if (!isAbort(reason) && likeController === controller) error.value = reasonMessage(reason)
  } finally {
    if (likeController === controller) {
      likeController = null
      likeBusy.value = false
    }
  }
}

async function openAlbum(): Promise<void> {
  const albumId = props.track?.album.id ?? 0
  if (albumId <= 0) return
  close()
  await router.push(`/album/${albumId}`)
}

async function openArtist(artistId: number): Promise<void> {
  if (artistId <= 0) return
  close()
  await router.push(`/artist/${artistId}`)
}

function toggleArtistPicker(): void {
  if (validArtists.value.length === 1) {
    void openArtist(validArtists.value[0]?.id ?? 0)
    return
  }
  pickerOpen.value = false
  artistPickerOpen.value = !artistPickerOpen.value
}

async function openInBrowser(): Promise<void> {
  const trackId = props.track?.id ?? 0
  if (trackId <= 0 || externalBusy.value) return
  externalBusy.value = true
  error.value = ''
  try {
    await externalLinkGateway.openNeteaseSong(trackId)
    close()
  } catch (reason) {
    error.value = reasonMessage(reason)
    externalBusy.value = false
  }
}

async function copyText(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error(t('player.copyUnavailable'))
    await navigator.clipboard.writeText(text)
    close()
  } catch (reason) {
    error.value = reasonMessage(reason)
  }
}

function copyTrackInfo(): void {
  const track = props.track
  if (track) void copyText(`${track.name} - ${formatArtists(track.artists)}`)
}

function copyTrackLink(): void {
  const trackId = props.track?.id ?? 0
  if (trackId > 0) void copyText(`https://music.163.com/song?id=${trackId}`)
}

async function togglePlaylistPicker(): Promise<void> {
  const user = authStore.session.user
  if (!user) {
    close()
    await router.push('/login/account')
    return
  }
  if (pickerOpen.value) {
    requestController?.abort('Playlist list closed')
    requestController = null
    pickerOpen.value = false
    loading.value = false
    return
  }
  requestController?.abort('Playlist list superseded')
  const controller = new AbortController()
  requestController = controller
  pickerOpen.value = true
  artistPickerOpen.value = false
  loading.value = true
  error.value = ''
  try {
    const page = await libraryGateway.playlistPage(user.userId, 0, controller.signal)
    if (requestController !== controller) return
    playlists.value = page.items.filter(
      (playlist) => playlist.creatorId === user.userId && playlist.id !== page.items[0]?.id,
    )
  } catch (reason) {
    if (!isAbort(reason)) error.value = reasonMessage(reason)
  } finally {
    if (requestController === controller) {
      requestController = null
      loading.value = false
    }
  }
}

async function addToPlaylist(playlistId: number): Promise<void> {
  const track = props.track
  if (!track || mutationId.value !== null) return
  mutationController?.abort('Playlist mutation superseded')
  const controller = new AbortController()
  mutationController = controller
  mutationId.value = playlistId
  error.value = ''
  try {
    await playlistGateway.addTracks(playlistId, [track.id], controller.signal)
    if (mutationController === controller) close()
  } catch (reason) {
    if (!isAbort(reason) && mutationController === controller) error.value = reasonMessage(reason)
  } finally {
    if (mutationController === controller) {
      mutationController = null
      mutationId.value = null
    }
  }
}

function onDocumentPointerDown(event: globalThis.PointerEvent): void {
  const root = menuRoot.value
  if (root && !root.contains(event.target as globalThis.Node)) close()
}

function onDocumentKeydown(event: globalThis.KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

watch(
  () => props.track,
  async (track) => {
    if (!track) return
    likeController?.abort('Track changed')
    likeState.value = null
    error.value = ''
    if (authStore.session.user) void loadLikeState(track.id)
    await nextTick()
    document.addEventListener('pointerdown', onDocumentPointerDown)
    document.addEventListener('keydown', onDocumentKeydown)
  },
)

onBeforeUnmount(() => {
  requestController?.abort('Track context menu disposed')
  mutationController?.abort('Track context menu disposed')
  likeController?.abort('Track context menu disposed')
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<style scoped lang="scss">
.track-context-menu {
  position: fixed;
  z-index: 1200;
  display: flex;
  width: 224px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  padding: 4px;
  border: 0;
  border-radius: var(--floating-radius);
  background: var(--color-surface-raised);
  box-shadow: var(--floating-shadow);
  flex-direction: column;
  overflow-y: auto;
  --floating-origin: top left;
}

.track-context-menu > button,
.playlist-submenu button,
.artist-submenu button {
  display: flex;
  min-height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
  background: transparent;
  font-size: 13px;
  text-align: left;
  transition:
    color 140ms ease,
    background-color 140ms ease;

  &:hover:not(:disabled),
  &:focus-visible:not(:disabled) {
    color: var(--color-text);
    background: var(--color-interactive-hover);
  }

  &:disabled {
    cursor: default;
    opacity: 0.45;
  }
}

.track-context-menu > button .app-icon {
  width: 16px;
  height: 16px;
}

.playlist-submenu,
.artist-submenu {
  display: flex;
  margin: 4px 2px 4px 22px;
  padding: 4px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  flex-direction: column;
  --floating-origin: top left;

  button {
    justify-content: space-between;
  }
}

.submenu-state,
.submenu-error {
  padding: 8px 10px;
  font-size: 13px;
  opacity: 0.7;
}

.submenu-error {
  color: var(--color-danger);
  opacity: 1;
}

.spinner {
  width: 14px;
  height: 14px;
  margin-left: auto;
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
