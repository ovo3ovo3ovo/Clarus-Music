<template>
  <nav class="navbar" data-tauri-drag-region>
    <button
      v-if="showBack"
      class="content-back-button"
      type="button"
      :title="t('nav.back')"
      :aria-label="t('nav.back')"
      @click="goBack"
    >
      <AppIcon name="arrow-left" />
    </button>

    <div class="navigation-links" :aria-label="t('nav.library')">
      <RouterLink to="/library/liked-songs">
        <AppIcon name="heart-solid" />
        <span>{{ t('nav.favorites') }}</span>
      </RouterLink>
      <RouterLink to="/daily/songs">
        <AppIcon name="calendar" />
        <span>{{ t('nav.dailySongs') }}</span>
      </RouterLink>
      <RouterLink to="/library/created-playlists">
        <AppIcon name="plus" />
        <span>{{ t('nav.createdPlaylists') }}</span>
      </RouterLink>
      <RouterLink to="/library/saved-playlists">
        <AppIcon name="list" />
        <span>{{ t('nav.savedPlaylists') }}</span>
      </RouterLink>
      <RouterLink to="/library/albums">
        <AppIcon name="album" />
        <span>{{ t('nav.savedAlbums') }}</span>
      </RouterLink>
      <RouterLink to="/library/artists">
        <AppIcon name="artist" />
        <span>{{ t('nav.artists') }}</span>
      </RouterLink>
      <RouterLink to="/library/history">
        <AppIcon name="history" />
        <span>{{ t('nav.playHistory') }}</span>
      </RouterLink>
      <form
        class="sidebar-search"
        :class="{ active: isSearchRoute }"
        role="search"
        :aria-label="t('nav.search')"
        @submit.prevent="submitSearch"
      >
        <button class="sidebar-search__submit" type="submit" :aria-label="t('nav.search')">
          <AppIcon name="search" />
        </button>
        <input
          v-model="searchInput"
          type="search"
          enterkeyhint="search"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('nav.searchPlaceholder')"
          :aria-label="t('nav.search')"
        />
      </form>
    </div>

    <div class="account-entry">
      <button
        class="account-trigger"
        type="button"
        :title="t('accountMenu.settings')"
        :aria-label="t('accountMenu.settings')"
        @click="toSettings"
      >
        <span class="avatar">
          <CoverImage
            v-if="authStore.session.user"
            :source="authStore.session.user.avatarUrl"
            :width="48"
            role="avatar"
            alt=""
          />
          <AppIcon v-else name="login" />
        </span>
        <span class="account-copy">
          <strong>{{ authStore.session.user?.nickname ?? 'Clarus Music' }}</strong>
          <small>{{ authStore.session.user ? t('nav.settings') : t('nav.login') }}</small>
        </span>
      </button>
    </div>

    <div
      class="sidebar-resizer"
      :class="{ 'is-resizing': resizingSidebar }"
      role="separator"
      tabindex="0"
      aria-controls="app-content"
      aria-orientation="vertical"
      :aria-label="t('nav.resizeSidebar')"
      :aria-valuemin="SIDEBAR_MIN_WIDTH"
      :aria-valuemax="Math.round(maxSidebarWidth)"
      :aria-valuenow="Math.round(sidebarWidth)"
      @pointerdown="startSidebarResize"
      @dblclick="resetSidebarWidth"
      @keydown="handleSidebarResizeKeydown"
    />
  </nav>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import { useAuthStore } from '@/features/auth/application/auth-store'
import { isPrimaryNavigationRoute } from '@/app/primary-navigation'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const authStore = useAuthStore()
const showBack = computed(() => !isPrimaryNavigationRoute(route.name))
const isSearchRoute = computed(() => route.name === 'search' || route.name === 'searchType')
const SIDEBAR_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 520
const CONTENT_MIN_WIDTH = 680
const SIDEBAR_STORAGE_KEY = 'clarus-music.sidebar-width'
const sidebarWidth = ref(SIDEBAR_MIN_WIDTH)
const maxSidebarWidth = ref(SIDEBAR_MAX_WIDTH)
const resizingSidebar = ref(false)
const searchInput = ref('')
let preferredSidebarWidth = SIDEBAR_MIN_WIDTH
let activePointerId: number | null = null
let pendingSidebarWidth: number | null = null
let resizeFrame: number | null = null

function goBack(): void {
  const historyBack = globalThis.window.history.state?.back
  if (typeof historyBack === 'string' && historyBack.length > 0) router.back()
  else void router.push('/daily/songs')
}

function toSettings(): void {
  void router.push('/settings')
}

function submitSearch(): void {
  const keywords = searchInput.value.trim()
  void router.push(keywords.length > 0 ? { name: 'search', params: { keywords } } : '/search')
}

function defaultSidebarWidth(): number {
  return Math.min(244, Math.max(SIDEBAR_MIN_WIDTH, globalThis.window.innerWidth * 0.16))
}

function resolveMaxSidebarWidth(): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      globalThis.window.innerWidth * 0.42,
      globalThis.window.innerWidth - CONTENT_MIN_WIDTH,
    ),
  )
}

function applySidebarWidth(width: number): void {
  maxSidebarWidth.value = resolveMaxSidebarWidth()
  const nextWidth = Math.min(maxSidebarWidth.value, Math.max(SIDEBAR_MIN_WIDTH, width))
  sidebarWidth.value = nextWidth
  document.documentElement.style.setProperty('--sidebar-width', `${nextWidth}px`)
}

function saveSidebarWidth(): void {
  try {
    globalThis.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(sidebarWidth.value)))
  } catch {
    // A private WebView may disable local storage; resizing should still work for this session.
  }
}

function flushPendingSidebarWidth(): void {
  resizeFrame = null
  if (pendingSidebarWidth === null) return
  preferredSidebarWidth = pendingSidebarWidth
  pendingSidebarWidth = null
  applySidebarWidth(preferredSidebarWidth)
}

function handleSidebarPointerMove(event: globalThis.PointerEvent): void {
  if (event.pointerId !== activePointerId) return
  event.preventDefault()
  pendingSidebarWidth = event.clientX
  if (resizeFrame === null) resizeFrame = globalThis.requestAnimationFrame(flushPendingSidebarWidth)
}

function stopSidebarResize(event?: globalThis.PointerEvent): void {
  if (event && event.pointerId !== activePointerId) return
  if (resizeFrame !== null) {
    globalThis.cancelAnimationFrame(resizeFrame)
    resizeFrame = null
  }
  flushPendingSidebarWidth()
  if (activePointerId !== null) saveSidebarWidth()
  activePointerId = null
  resizingSidebar.value = false
  document.documentElement.classList.remove('sidebar-resizing')
  document.removeEventListener('pointermove', handleSidebarPointerMove)
  document.removeEventListener('pointerup', stopSidebarResize)
  document.removeEventListener('pointercancel', stopSidebarResize)
}

function startSidebarResize(event: globalThis.PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  activePointerId = event.pointerId
  resizingSidebar.value = true
  document.documentElement.classList.add('sidebar-resizing')
  document.addEventListener('pointermove', handleSidebarPointerMove, { passive: false })
  document.addEventListener('pointerup', stopSidebarResize)
  document.addEventListener('pointercancel', stopSidebarResize)
}

function setAndSaveSidebarWidth(width: number): void {
  preferredSidebarWidth = width
  applySidebarWidth(preferredSidebarWidth)
  saveSidebarWidth()
}

function resetSidebarWidth(): void {
  setAndSaveSidebarWidth(defaultSidebarWidth())
}

function handleSidebarResizeKeydown(event: globalThis.KeyboardEvent): void {
  const step = event.shiftKey ? 32 : 12
  if (event.key === 'ArrowLeft') setAndSaveSidebarWidth(sidebarWidth.value - step)
  else if (event.key === 'ArrowRight') setAndSaveSidebarWidth(sidebarWidth.value + step)
  else if (event.key === 'Home') setAndSaveSidebarWidth(SIDEBAR_MIN_WIDTH)
  else if (event.key === 'End') setAndSaveSidebarWidth(maxSidebarWidth.value)
  else return
  event.preventDefault()
}

function handleWindowResize(): void {
  applySidebarWidth(preferredSidebarWidth)
}

watch(
  () => [route.name, route.params.keywords] as const,
  ([name, keywords]) => {
    searchInput.value = name === 'search' || name === 'searchType' ? String(keywords ?? '') : ''
  },
  { immediate: true },
)

onMounted(() => {
  let storedWidth = Number.NaN
  try {
    storedWidth = Number(globalThis.localStorage.getItem(SIDEBAR_STORAGE_KEY))
  } catch {
    // Fall back to the responsive default when local storage is unavailable.
  }
  preferredSidebarWidth = Number.isFinite(storedWidth) ? storedWidth : defaultSidebarWidth()
  applySidebarWidth(preferredSidebarWidth)
  globalThis.window.addEventListener('resize', handleWindowResize)
})

onBeforeUnmount(() => {
  stopSidebarResize()
  globalThis.window.removeEventListener('resize', handleWindowResize)
})
</script>

<style scoped lang="scss">
.navbar {
  position: fixed;
  z-index: var(--z-nav);
  top: 0;
  bottom: 0;
  left: 0;
  display: flex;
  width: var(--sidebar-width);
  padding: 56px 12px 14px;
  flex-direction: column;
  color: var(--color-text);
  background: var(--color-navbar-bg);
  transition: width var(--motion-base) var(--ease-out);
  app-region: drag;
  -webkit-app-region: drag;
}

.navigation-links a,
.account-entry,
.sidebar-search {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.content-back-button {
  position: fixed;
  z-index: var(--z-menu);
  top: 16px;
  left: calc(var(--sidebar-width) + 18px);
  display: grid;
  width: 34px;
  height: 34px;
  padding: 9px;
  border: 0;
  border-radius: 5px;
  color: var(--color-text);
  background: transparent;
  place-items: center;
  transition:
    left var(--motion-base) var(--ease-out),
    color var(--motion-fast) ease,
    transform var(--motion-hover-emphasis) var(--ease-out);
  transform-origin: center;
  app-region: no-drag;
  -webkit-app-region: no-drag;

  &:hover {
    color: var(--color-text);
    background: transparent;
    transform: scale(var(--scale-hover-icon));
  }

  &:focus-visible:not(:hover) {
    color: var(--color-text);
    background: transparent;
    transform: none;
    will-change: auto;
  }

  &:active {
    transform: scale(var(--scale-hover-icon));
  }
}

.navigation-links {
  display: grid;
  gap: 1px;
  margin-top: 4px;
  isolation: isolate;

  a {
    display: flex;
    position: relative;
    z-index: 0;
    min-height: 34px;
    padding: 0 10px;
    border-radius: 5px;
    align-items: center;
    gap: 9px;
    color: var(--color-secondary);
    font-size: 12px;
    font-weight: var(--font-weight-medium);
    letter-spacing: -0.006em;
    transition:
      color var(--motion-fast) ease,
      transform var(--motion-hover-emphasis) var(--ease-out);
    transform-origin: center;

    .app-icon {
      width: 17px;
      height: 17px;
      opacity: 0.72;
    }

    &:hover {
      color: var(--color-text);
      background: transparent;
      transform: scale(var(--scale-hover-sidebar-row));
      z-index: 2;
    }

    &:focus-visible:not(:hover) {
      color: var(--color-text);
      background: transparent;
      transform: none;
      z-index: 1;
    }

    &:active {
      transform: scale(var(--scale-hover-sidebar-row));
    }
  }

  a.router-link-exact-active {
    color: var(--color-primary);
    background: transparent;
    font-weight: var(--font-weight-medium);
    text-decoration: none;

    &::after {
      position: absolute;
      top: 50%;
      left: 2px;
      width: 2px;
      height: 14px;
      border-radius: 1px;
      background: currentcolor;
      content: '';
      opacity: 0.86;
      transform: translateY(-50%);
    }

    .app-icon {
      opacity: 1;
    }
  }
}

.sidebar-search {
  display: flex;
  min-width: 0;
  min-height: 34px;
  margin-top: 1px;
  padding: 0 7px;
  border: 0;
  border-radius: 5px;
  align-items: center;
  gap: 4px;
  color: var(--color-secondary);
  background: transparent;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease;

  &:hover,
  &:focus-within {
    color: var(--color-text);
    background: transparent;
  }

  &.active {
    color: var(--color-primary);
  }

  input {
    width: 100%;
    min-width: 0;
    height: 30px;
    padding: 0 2px;
    border: 0;
    outline: 0;
    color: inherit;
    background: transparent;
    box-shadow: none;
    font-size: 12px;
    font-weight: var(--font-weight-regular);
    letter-spacing: -0.006em;
    app-region: no-drag;
    -webkit-app-region: no-drag;

    &::placeholder {
      color: var(--color-text-tertiary);
      opacity: 1;
    }

    &:focus-visible {
      box-shadow: none;
    }
  }
}

.sidebar-search__submit {
  display: grid;
  width: 22px;
  height: 22px;
  padding: 3px;
  border: 0;
  border-radius: 4px;
  flex: 0 0 22px;
  color: currentcolor;
  background: transparent;
  place-items: center;
  transition:
    color var(--motion-fast) ease,
    transform var(--motion-hover-emphasis) var(--ease-out);
  transform-origin: center;
  app-region: no-drag;
  -webkit-app-region: no-drag;

  .app-icon {
    width: 15px;
    height: 15px;
    opacity: 0.76;
  }

  &:hover {
    color: var(--color-text);
    background: transparent;
    transform: scale(var(--scale-hover-icon));
  }

  &:focus-visible:not(:hover) {
    color: var(--color-text);
    background: transparent;
    transform: none;
    outline: 1px solid color-mix(in srgb, var(--color-text) 48%, transparent);
    outline-offset: 1px;
  }

  &:active {
    transform: scale(var(--scale-hover-icon));
  }
}

.account-entry {
  margin-top: auto;
  padding-top: 12px;
}

.account-trigger {
  display: flex;
  position: relative;
  z-index: 0;
  width: 100%;
  min-height: 42px;
  padding: 5px;
  border: 0;
  border-radius: 6px;
  align-items: center;
  gap: 10px;
  color: inherit;
  background: transparent;
  text-align: left;
  transition: color var(--motion-fast) ease;
  app-region: no-drag;
  -webkit-app-region: no-drag;

  &:hover {
    background: transparent;
    z-index: 2;
  }

  &:focus-visible:not(:hover) {
    background: transparent;
    z-index: 1;
  }

  &:active {
    transform: none;
  }
}

.avatar {
  display: grid;
  width: 36px;
  height: 36px;
  overflow: hidden;
  border: 0;
  border-radius: 50%;
  flex: 0 0 36px;
  color: var(--color-on-primary);
  background: var(--color-primary-bg-for-transparent);
  place-items: center;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .app-icon {
    width: 17px;
    height: 17px;
  }
}

.account-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 13px;
    font-weight: var(--font-weight-medium);
    letter-spacing: -0.008em;
  }

  small {
    color: var(--color-text-secondary);
    font-size: 10px;
  }
}

.sidebar-resizer {
  position: absolute;
  z-index: 4;
  top: 0;
  right: -6px;
  bottom: 0;
  width: 12px;
  cursor: col-resize;
  touch-action: none;
  app-region: no-drag;
  -webkit-app-region: no-drag;

  &::after {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    background: transparent;
    content: '';
    opacity: 0;
    transform: translateX(-50%);
    transition:
      opacity var(--motion-fast) ease,
      background-color var(--motion-fast) ease,
      box-shadow var(--motion-fast) ease;
  }

  &:hover::after,
  &:focus-visible::after,
  &.is-resizing::after {
    opacity: 1;
    background: color-mix(in srgb, var(--color-text) 28%, transparent);
    box-shadow: none;
  }
}

:global(html.sidebar-resizing) .navbar,
:global(html.sidebar-resizing) .content-back-button {
  transition: none;
}

@media (max-width: 1336px) {
  .navbar {
    padding-right: 12px;
    padding-left: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .content-back-button,
  .navigation-links a,
  .sidebar-search__submit,
  .account-trigger {
    transition: none;

    &:hover,
    &:focus-visible,
    &:active {
      transform: none;
      will-change: auto;
    }
  }
}
</style>
