import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import type { AuthSession } from '@/features/auth/domain/auth'
import { desktop } from './desktop'

declare global {
  interface Window {
    __CLARUS_SURFACE__?: 'detail'
    __CLARUS_DETAIL_ROUTE__?: string
    __CLARUS_AUTH_SESSION__?: unknown
  }
}

interface DetailSurfaceBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface DetailNavigationPayload {
  readonly route?: unknown
}

const DETAIL_NAVIGATE_EVENT = 'clarus-detail-navigate'
const DETAIL_BACK_EVENT = 'clarus-detail-back'
const SIDEBAR_WIDTH_EVENT = 'clarus-sidebar-width'

export function initialDetailSurfaceRoute(): string | null {
  if (window.__CLARUS_SURFACE__ !== 'detail') return null
  const route = window.__CLARUS_DETAIL_ROUTE__
  return typeof route === 'string' && route.startsWith('/') ? route : null
}

export function initialDetailAuthSession(): AuthSession | null {
  if (initialDetailSurfaceRoute() === null) return null
  const session = window.__CLARUS_AUTH_SESSION__
  if (session === null || typeof session !== 'object') return null
  const candidate = session as Partial<AuthSession>
  if (typeof candidate.authenticated !== 'boolean') return null
  if (candidate.user === null) return candidate.authenticated ? null : (candidate as AuthSession)
  if (
    candidate.user === undefined ||
    typeof candidate.user !== 'object' ||
    !Number.isSafeInteger(candidate.user.userId) ||
    typeof candidate.user.nickname !== 'string' ||
    typeof candidate.user.avatarUrl !== 'string' ||
    typeof candidate.user.signature !== 'string' ||
    !Number.isSafeInteger(candidate.user.vipType)
  ) {
    return null
  }
  return candidate.authenticated ? (candidate as AuthSession) : null
}

export function routeUsesIsolatedSurface(route: RouteLocationNormalizedLoaded): boolean {
  return route.meta.isolatedSurface === true
}

function cssPixels(name: string, fallback: number): number {
  const value = Number.parseFloat(
    globalThis.getComputedStyle(document.documentElement).getPropertyValue(name),
  )
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function detailBounds(): DetailSurfaceBounds {
  const x = cssPixels('--sidebar-width', 228)
  const playerHeight = cssPixels('--player-height', 72)
  return {
    x,
    y: 0,
    width: Math.max(320, globalThis.innerWidth - x),
    height: Math.max(320, globalThis.innerHeight - playerHeight),
  }
}

export async function emitDetailBack(): Promise<void> {
  if (!desktop.isDesktop) return
  await emitTo('main', DETAIL_BACK_EVENT)
}

export function installDetailSurfaceNavigation(router: Router): () => void {
  if (!desktop.isDesktop) return () => undefined
  return router.beforeEach((to, from) => {
    if (to.fullPath === from.fullPath) return true
    void emitTo<DetailNavigationPayload>('main', DETAIL_NAVIGATE_EVENT, {
      route: to.fullPath,
    })
    return false
  })
}

export function installDetailSurfaceCoordinator(
  router: Router,
  authSession: () => AuthSession,
): () => void {
  if (!desktop.isDesktop || initialDetailSurfaceRoute() !== null) return () => undefined

  let disposed = false
  let listenersReady = false
  let resizeFrame: number | null = null
  let pendingRoute: RouteLocationNormalizedLoaded | null = router.currentRoute.value
  const unlisteners: UnlistenFn[] = []

  const present = (route: RouteLocationNormalizedLoaded): void => {
    if (disposed) return
    if (!routeUsesIsolatedSurface(route)) {
      void invoke('dismiss_detail_surface').catch(() => undefined)
      return
    }
    void invoke('present_detail_surface', {
      route: route.fullPath,
      bounds: detailBounds(),
      authSession: authSession(),
    }).catch((error: unknown) => {
      globalThis.console.error('Failed to present isolated detail surface', error)
    })
  }

  const requestPresent = (route: RouteLocationNormalizedLoaded): void => {
    pendingRoute = route
    if (!listenersReady) return
    pendingRoute = null
    present(route)
  }

  const resize = (): void => {
    if (resizeFrame !== null) globalThis.cancelAnimationFrame(resizeFrame)
    resizeFrame = globalThis.requestAnimationFrame(() => {
      resizeFrame = null
      if (disposed || !routeUsesIsolatedSurface(router.currentRoute.value)) return
      void invoke('resize_detail_surface', { bounds: detailBounds() }).catch(() => undefined)
    })
  }

  const removeAfter = router.afterEach((to, _from, failure) => {
    if (failure === undefined) requestPresent(to)
  })
  globalThis.addEventListener('resize', resize)
  globalThis.addEventListener(SIDEBAR_WIDTH_EVENT, resize)
  void Promise.all([
    listen<DetailNavigationPayload>(DETAIL_NAVIGATE_EVENT, (event) => {
      const route = event.payload?.route
      if (typeof route === 'string' && route.startsWith('/')) void router.push(route)
    }),
    listen(DETAIL_BACK_EVENT, () => router.back()),
  ]).then((listeners) => {
    if (disposed) {
      for (const unlisten of listeners) unlisten()
      return
    }
    unlisteners.push(...listeners)
    listenersReady = true
    const route = pendingRoute
    pendingRoute = null
    if (route !== null) present(route)
  })

  return () => {
    if (disposed) return
    disposed = true
    pendingRoute = null
    if (resizeFrame !== null) globalThis.cancelAnimationFrame(resizeFrame)
    resizeFrame = null
    removeAfter()
    globalThis.removeEventListener('resize', resize)
    globalThis.removeEventListener(SIDEBAR_WIDTH_EVENT, resize)
    for (const unlisten of unlisteners) unlisten()
    void invoke('dismiss_detail_surface').catch(() => undefined)
  }
}

export function notifyDetailSurfaceSidebarWidth(): void {
  globalThis.dispatchEvent(new Event(SIDEBAR_WIDTH_EVENT))
}
