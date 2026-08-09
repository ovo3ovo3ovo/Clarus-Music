<template>
  <div ref="appShell" class="app-shell">
    <AppNavbar />
    <main
      id="app-content"
      class="app-content"
      data-app-scroll-container
      data-tauri-drag-region
      :class="{ 'has-back-navigation': hasBackNavigation }"
    >
      <RouterView v-slot="{ Component, route: viewRoute }">
        <KeepAlive :max="3">
          <component
            :is="Component"
            v-if="viewRoute.meta.keepAlive"
            :key="String(viewRoute.meta.cacheKey ?? viewRoute.name ?? viewRoute.path)"
          />
        </KeepAlive>
        <component
          :is="Component"
          v-if="
            !viewRoute.meta.keepAlive && (!viewRoute.meta.isolatedSurface || !desktop.isDesktop)
          "
          :key="viewRoute.name === 'artist' ? 'artist' : viewRoute.fullPath"
        />
      </RouterView>
    </main>
    <PlayerBar />
    <ToastHost />
    <AppDialogHost />
    <Transition name="lyrics-slide" @after-leave="handleLyricsAfterLeave">
      <div v-if="lyricsStore.visible" class="lyrics-overlay-shell">
        <LyricsOverlay />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppNavbar from '@/components/layout/AppNavbar.vue'
import { isPrimaryNavigationRoute } from './primary-navigation'
import { router } from './router'
import { installRouteScrollManager } from './route-scroll'
import {
  installDetailSurfaceCoordinator,
  type DetailSurfaceCoordinator,
} from '@/platform/detail-surface'
import ToastHost from './ToastHost.vue'
import AppDialogHost from '@/components/common/AppDialogHost.vue'
import PlayerBar from '@/features/player/presentation/PlayerBar.vue'
import { useLyricsStore } from '@/features/lyrics/application/lyrics-store'
import { usePlayerStore } from '@/features/player/application/player-store'
import { useAuthStore } from '@/features/auth/application/auth-store'
import { desktop } from '@/platform/desktop'
import { installWindowDrag } from '@/platform/window-drag'

const LyricsOverlay = defineAsyncComponent(() => import('@/features/lyrics/LyricsOverlay.vue'))
const lyricsStore = useLyricsStore()
const player = usePlayerStore()
const authStore = useAuthStore()
const route = useRoute()
const appShell = ref<globalThis.HTMLElement | null>(null)
const hasBackNavigation = computed(() => !isPrimaryNavigationRoute(route.name))
let removeRouteScrollManager: (() => void) | null = null
let detailSurfaceCoordinator: DetailSurfaceCoordinator | null = null
let removeWindowDrag: (() => void) | null = null
let windowDragDisposed = false

function isPlaybackShortcutTarget(target: globalThis.EventTarget | null): boolean {
  if (!(target instanceof globalThis.HTMLElement)) return false
  if (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  ) {
    return false
  }
  return target.closest('button, a, [role="button"], [role="link"], [role="menuitem"]') === null
}

function handlePlaybackKeydown(event: globalThis.KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    (event.key !== ' ' && event.code !== 'Space') ||
    !player.enabled ||
    !isPlaybackShortcutTarget(event.target)
  ) {
    return
  }
  event.preventDefault()
  void player.togglePlayback()
}

async function installNativeWindowDrag(): Promise<void> {
  if (!desktop.isDesktop || appShell.value === null) return

  const surface = appShell.value
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  if (windowDragDisposed) return

  removeWindowDrag = installWindowDrag(surface, getCurrentWindow(), (error: unknown) => {
    globalThis.console.error('Failed to start window dragging', error)
  })
}

function handleLyricsAfterLeave(): void {
  if (!lyricsStore.visible) detailSurfaceCoordinator?.setOccluded(false)
}

watch(
  () => lyricsStore.visible,
  (visible) => {
    if (visible) detailSurfaceCoordinator?.setOccluded(true)
  },
  { flush: 'sync' },
)

onMounted(() => {
  removeRouteScrollManager = installRouteScrollManager(router)
  detailSurfaceCoordinator = installDetailSurfaceCoordinator(router, () => authStore.session)
  detailSurfaceCoordinator.setOccluded(lyricsStore.visible)
  document.addEventListener('keydown', handlePlaybackKeydown, true)
  void installNativeWindowDrag().catch((error: unknown) => {
    globalThis.console.error('Failed to install window dragging', error)
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handlePlaybackKeydown, true)
  windowDragDisposed = true
  removeWindowDrag?.()
  removeWindowDrag = null
  removeRouteScrollManager?.()
  removeRouteScrollManager = null
  detailSurfaceCoordinator?.dispose()
  detailSurfaceCoordinator = null
})
</script>

<style scoped lang="scss">
.lyrics-overlay-shell {
  position: fixed;
  z-index: 240;
  inset: 0;
  overflow: hidden;
  background: var(--color-body-bg);
}

.lyrics-slide-enter-active .lyrics-overlay,
.lyrics-slide-leave-active .lyrics-overlay {
  transition: transform 380ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

.lyrics-slide-enter-from .lyrics-overlay,
.lyrics-slide-leave-to .lyrics-overlay {
  transform: translate3d(0, 100%, 0);
}

@media (prefers-reduced-motion: reduce) {
  .lyrics-slide-enter-active .lyrics-overlay,
  .lyrics-slide-leave-active .lyrics-overlay {
    transition: none;
  }
}
</style>
