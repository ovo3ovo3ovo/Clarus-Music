export type IntersectionListener = (isIntersecting: boolean) => void

interface ObserverPool {
  readonly observer: IntersectionObserver
  readonly listeners: Map<Element, Set<IntersectionListener>>
}

const observerPools = new Map<Element | null, ObserverPool>()

function createPool(root: Element | null): ObserverPool {
  const listeners = new Map<Element, Set<IntersectionListener>>()
  const observer = new globalThis.IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = entry.target ?? (listeners.size === 1 ? listeners.keys().next().value : null)
        if (!target) continue
        for (const listener of listeners.get(target) ?? []) listener(entry.isIntersecting)
      }
    },
    { root, rootMargin: '50% 0px', threshold: 0 },
  )
  return { observer, listeners }
}

/**
 * Shares one native observer per app scroller. Hundreds of cover components
 * can therefore subscribe without constructing hundreds of independent
 * WebKit observer graphs.
 */
export function observeNearViewport(
  element: Element,
  root: Element | null,
  listener: IntersectionListener,
): () => void {
  if (typeof globalThis.IntersectionObserver === 'undefined') {
    listener(true)
    return () => undefined
  }

  let pool = observerPools.get(root)
  if (!pool) {
    pool = createPool(root)
    observerPools.set(root, pool)
  }
  let elementListeners = pool.listeners.get(element)
  if (!elementListeners) {
    elementListeners = new Set()
    pool.listeners.set(element, elementListeners)
    pool.observer.observe(element)
  }
  elementListeners.add(listener)

  return () => {
    const current = observerPools.get(root)
    const currentListeners = current?.listeners.get(element)
    if (!current || !currentListeners || !currentListeners.delete(listener)) return
    if (currentListeners.size === 0) {
      current.listeners.delete(element)
      current.observer.unobserve?.(element)
    }
    if (current.listeners.size === 0) {
      current.observer.disconnect()
      observerPools.delete(root)
    }
  }
}
