import { nextTick } from 'vue'
import type { Router } from 'vue-router'

export interface ScrollContainer {
  scrollTop: number
  scrollTo(options: { top: number; behavior?: ScrollBehavior }): void
}

export type ScrollContainerProvider = () => ScrollContainer | null

/** Keeps the app's fixed scroll container in sync with router history. */
export function installRouteScrollManager(
  router: Pick<Router, 'beforeEach' | 'afterEach'>,
  getContainer: ScrollContainerProvider = () =>
    document.querySelector('.app-content') as ScrollContainer | null,
): () => void {
  const positions = new Map<string, number>()
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
