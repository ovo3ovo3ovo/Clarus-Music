import { nextTick } from 'vue'
import type { Router } from 'vue-router'

export interface ScrollContainer {
  scrollTop: number
  scrollTo(options: { top: number; behavior?: ScrollBehavior }): void
}

export type ScrollContainerProvider = () => ScrollContainer | null

export const MAX_ROUTE_SCROLL_POSITIONS = 256

export function createRouteScrollPositionStore(limit = MAX_ROUTE_SCROLL_POSITIONS) {
  const positions = new Map<string, number>()
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_ROUTE_SCROLL_POSITIONS

  return {
    get(path: string): number | undefined {
      const value = positions.get(path)
      if (value === undefined) return undefined
      positions.delete(path)
      positions.set(path, value)
      return value
    },
    set(path: string, value: number): void {
      if (!Number.isFinite(value)) return
      positions.delete(path)
      positions.set(path, Math.max(0, value))
      while (positions.size > boundedLimit) {
        const oldest = positions.keys().next().value
        if (oldest === undefined) break
        positions.delete(oldest)
      }
    },
    size(): number {
      return positions.size
    },
    clear(): void {
      positions.clear()
    },
  }
}

/** Keeps the app's fixed scroll container in sync with router history. */
export function installRouteScrollManager(
  router: Pick<Router, 'beforeEach' | 'afterEach'>,
  getContainer: ScrollContainerProvider = () =>
    document.querySelector('.app-content') as ScrollContainer | null,
): () => void {
  const positions = createRouteScrollPositionStore()
  let navigationVersion = 0

  const removeBefore = router.beforeEach((to, from) => {
    if (to.fullPath === from.fullPath) return
    const container = getContainer()
    if (container !== null) positions.set(from.fullPath, container.scrollTop)
  })
  const removeAfter = router.afterEach((to, _from, failure) => {
    if (failure !== undefined) return
    const version = ++navigationVersion
    void nextTick(() => {
      if (version !== navigationVersion) return
      getContainer()?.scrollTo({
        top: positions.get(to.fullPath) ?? 0,
        behavior: 'auto',
      })
    })
  })

  return () => {
    removeBefore()
    removeAfter()
    positions.clear()
  }
}
