import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import type { AuthSession } from '@/features/auth/domain/auth'
import { desktop } from './desktop'

declare global {
  interface Window {
    __CLARUS_SURFACE__?: 'detail'
    __CLARUS_DETAIL_LABEL__?: string
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

function initialDetailSurfaceLabel(): string | null {
  if (window.__CLARUS_SURFACE__ !== 'detail') return null
  const label = window.__CLARUS_DETAIL_LABEL__
  return typeof label === 'string' && /^clarus-detail-\d{1,20}$/.test(label) ? label : null
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

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()))
}

export async function notifyDetailSurfaceReady(): Promise<boolean> {
  if (!desktop.isDesktop) return false
  const label = initialDetailSurfaceLabel()
  if (label === null) return false
  // Vue's mounted hook runs before its pixels are guaranteed to be committed.
  // Two compositor turns keep the old native surface visible until the new
  // route has produced a real frame instead of WebKit's blank backing layer.
  await nextAnimationFrame()
  await nextAnimationFrame()
  return invoke<boolean>('detail_surface_ready', { label })
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

export interface DetailSurfaceCoordinator {
  readonly setOccluded: (occluded: boolean) => void
  readonly dispose: () => void
}

const inactiveDetailSurfaceCoordinator: DetailSurfaceCoordinator = {
  setOccluded: () => undefined,
  dispose: () => undefined,
}

export function installDetailSurfaceCoordinator(
  router: Router,
  authSession: () => AuthSession,
): DetailSurfaceCoordinator {
  if (!desktop.isDesktop || initialDetailSurfaceRoute() !== null) {
    return inactiveDetailSurfaceCoordinator
  }

  let disposed = false
  let listenersReady = false
  let occluded = false
  let occludedRoute: string | null = null
  let resizeFrame: number | null = null
  let pendingRoute: RouteLocationNormalizedLoaded | null = router.currentRoute.value
  let commandTail = Promise.resolve()
  const unlisteners: UnlistenFn[] = []

  const enqueue = (
    command: string,
    args?: Record<string, unknown>,
    onError: (error: unknown) => void = () => undefined,
    onSuccess: (result: unknown) => void = () => undefined,
  ): void => {
    commandTail = commandTail.then(async () => {
      try {
        onSuccess(await invoke(command, args))
      } catch (error) {
        onError(error)
      }
    })
  }

  const dismiss = (): void => enqueue('dismiss_detail_surface')

  const present = (route: RouteLocationNormalizedLoaded): void => {
    if (disposed) return
    if (occluded || !routeUsesIsolatedSurface(route)) {
      dismiss()
      return
    }
    enqueue(
      'present_detail_surface',
      {
        route: route.fullPath,
        theme: document.documentElement.dataset.theme === 'oled' ? 'oled' : 'light',
        bounds: detailBounds(),
        authSession: authSession(),
      },
      (error: unknown) => {
        globalThis.console.error('Failed to present isolated detail surface', error)
      },
    )
  }

  const requestPresent = (route: RouteLocationNormalizedLoaded): void => {
    pendingRoute = route
    if (!listenersReady) return
    if (occluded) {
      if (occludedRoute !== null && route.fullPath !== occludedRoute) {
        occludedRoute = null
        dismiss()
      }
      return
    }
    pendingRoute = null
    present(route)
  }

  const resize = (): void => {
    if (resizeFrame !== null) globalThis.cancelAnimationFrame(resizeFrame)
    resizeFrame = globalThis.requestAnimationFrame(() => {
      resizeFrame = null
      if (disposed || occluded || !routeUsesIsolatedSurface(router.currentRoute.value)) return
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
    if (occluded) return
    const route = pendingRoute
    pendingRoute = null
    if (route !== null) present(route)
  })

  const setOccluded = (nextOccluded: boolean): void => {
    if (disposed || occluded === nextOccluded) return
    occluded = nextOccluded
    if (occluded) {
      occludedRoute = routeUsesIsolatedSurface(router.currentRoute.value)
        ? router.currentRoute.value.fullPath
        : null
      pendingRoute = router.currentRoute.value
      enqueue('hide_detail_surface')
      return
    }
    const route = pendingRoute ?? router.currentRoute.value
    pendingRoute = null
    const canRestore = occludedRoute !== null && route.fullPath === occludedRoute
    occludedRoute = null
    if (!listenersReady) {
      pendingRoute = route
      return
    }
    if (!canRestore || !routeUsesIsolatedSurface(route)) {
      present(route)
      return
    }
    enqueue(
      'show_detail_surface',
      { bounds: detailBounds() },
      () => present(route),
      (restored) => {
        if (restored !== true) present(route)
      },
    )
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    pendingRoute = null
    occludedRoute = null
    if (resizeFrame !== null) globalThis.cancelAnimationFrame(resizeFrame)
    resizeFrame = null
    removeAfter()
    globalThis.removeEventListener('resize', resize)
    globalThis.removeEventListener(SIDEBAR_WIDTH_EVENT, resize)
    for (const unlisten of unlisteners) unlisten()
    dismiss()
  }

  return { setOccluded, dispose }
}

export function notifyDetailSurfaceSidebarWidth(): void {
  globalThis.dispatchEvent(new Event(SIDEBAR_WIDTH_EVENT))
}
