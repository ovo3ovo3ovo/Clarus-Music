<template>
  <div ref="appShell" class="app-shell">
    <AppNavbar />
    <main
      id="app-content"
      class="app-content"
      data-tauri-drag-region
      :class="{ 'has-back-navigation': hasBackNavigation }"
    >
      <RouterView v-slot="{ Component, route: viewRoute }">
        <KeepAlive :max="10">
          <component
            :is="Component"
            v-if="viewRoute.meta.keepAlive"
            :key="String(viewRoute.meta.cacheKey ?? viewRoute.name ?? viewRoute.path)"
          />
        </KeepAlive>
        <component :is="Component" v-if="!viewRoute.meta.keepAlive" :key="viewRoute.fullPath" />
      </RouterView>
    </main>
    <PlayerBar />
    <ToastHost />
    <AppDialogHost />
    <Transition name="lyrics-slide">
      <LyricsOverlay v-if="lyricsStore.visible" />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppNavbar from '@/components/layout/AppNavbar.vue'
import { isPrimaryNavigationRoute } from './primary-navigation'
import { router } from './router'
import { installRouteScrollManager } from './route-scroll'
import ToastHost from './ToastHost.vue'
import AppDialogHost from '@/components/common/AppDialogHost.vue'
import PlayerBar from '@/features/player/presentation/PlayerBar.vue'
import { useLyricsStore } from '@/features/lyrics/application/lyrics-store'
import { usePlayerStore } from '@/features/player/application/player-store'
import { desktop } from '@/platform/desktop'
import { installWindowDrag } from '@/platform/window-drag'

const LyricsOverlay = defineAsyncComponent(() => import('@/features/lyrics/LyricsOverlay.vue'))
const lyricsStore = useLyricsStore()
const player = usePlayerStore()
const route = useRoute()
const appShell = ref<globalThis.HTMLElement | null>(null)
const hasBackNavigation = computed(() => !isPrimaryNavigationRoute(route.name))
let removeRouteScrollManager: (() => void) | null = null
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

onMounted(() => {
  removeRouteScrollManager = installRouteScrollManager(router)
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
})
</script>
