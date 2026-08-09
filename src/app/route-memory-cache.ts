import type { Router } from 'vue-router'
import { clearWebKitMemoryCache } from '@/platform/webkit-memory-cache'

/** Maximum time abandoned route resources may remain in WebKit's memory cache. */
export const ROUTE_MEMORY_CACHE_MAX_AGE_MS = 30_000

export type MemoryCacheTrimmer = () => Promise<unknown>

/**
 * Schedules a best-effort WebKit memory-cache trim no later than 30 seconds
 * after the first route departure. Later navigations never postpone that
 * deadline; a continuous navigation session is therefore trimmed at most once
 * per interval instead of retaining everything until the user stops browsing.
 *
 * It intentionally does not alter Vue's route lifecycle:
 * primary views keep their existing KeepAlive behavior and detail views retain
 * their existing immediate unmount behavior.
 */
export function installRouteMemoryCacheTrimmer(
  router: Pick<Router, 'afterEach'>,
  trimMemoryCache: MemoryCacheTrimmer = clearWebKitMemoryCache,
  maxAgeMs = ROUTE_MEMORY_CACHE_MAX_AGE_MS,
): () => void {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null
  let disposed = false

  const clearTimer = () => {
    if (timer === null) return
    globalThis.clearTimeout(timer)
    timer = null
  }

  const removeAfter = router.afterEach((to, from, failure) => {
    if (disposed || failure !== undefined || to.fullPath === from.fullPath) return
    // Keep the oldest pending deadline. Resetting this timer on every route
    // change would let an uninterrupted artist DFS retain resources forever.
    if (timer !== null) return
    timer = globalThis.setTimeout(() => {
      timer = null
      if (disposed) return
      // Cleanup is intentionally detached from router navigation. Native
      // failures and timeouts are best-effort and cannot surface as route errors.
      void Promise.resolve(trimMemoryCache()).catch(() => undefined)
    }, maxAgeMs)
  })

  return () => {
    if (disposed) return
    disposed = true
    clearTimer()
    removeAfter()
  }
}
