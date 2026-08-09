export type ScrollActivityListener = (active: boolean) => void

interface ScrollActivityPool {
  readonly root: Element
  readonly listeners: Set<ScrollActivityListener>
  readonly handleScroll: () => void
  active: boolean
  settleTimer: ReturnType<typeof globalThis.setTimeout> | null
}

const SETTLE_DELAY_MS = 180
const pools = new Map<Element, ScrollActivityPool>()

function notify(pool: ScrollActivityPool): void {
  for (const listener of pool.listeners) listener(pool.active)
}

function createPool(root: Element): ScrollActivityPool {
  const pool: ScrollActivityPool = {
    root,
    listeners: new Set(),
    active: false,
    settleTimer: null,
    handleScroll: () => {
      if (!pool.active) {
        pool.active = true
        notify(pool)
      }
      if (pool.settleTimer !== null) globalThis.clearTimeout(pool.settleTimer)
      pool.settleTimer = globalThis.setTimeout(() => {
        pool.settleTimer = null
        pool.active = false
        notify(pool)
      }, SETTLE_DELAY_MS)
    },
  }
  root.addEventListener('scroll', pool.handleScroll, { passive: true })
  return pool
}

/**
 * Shares one scroll-activity listener for the application scroller. Dense
 * image lists suspend native fetch/decode work while scroll positions are
 * changing, then load only the final viewport after momentum settles.
 */
export function subscribeScrollActivity(
  root: Element,
  listener: ScrollActivityListener,
): () => void {
  let pool = pools.get(root)
  if (!pool) {
    pool = createPool(root)
    pools.set(root, pool)
  }
  pool.listeners.add(listener)
  listener(pool.active)
  return () => {
    const current = pools.get(root)
    if (!current || !current.listeners.delete(listener)) return
    if (current.listeners.size > 0) return
    current.root.removeEventListener('scroll', current.handleScroll)
    if (current.settleTimer !== null) globalThis.clearTimeout(current.settleTimer)
    pools.delete(root)
  }
}
