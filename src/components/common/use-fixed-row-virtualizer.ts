import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
} from 'vue'
import { useVirtualizer, type VirtualItem } from '@tanstack/vue-virtual'

type ScrollElement = globalThis.HTMLElement

export type FixedVirtualRow = Pick<VirtualItem, 'key' | 'index' | 'start'>

export interface FixedRowVirtualizerOptions<Item> {
  readonly rowHeight: number
  readonly virtualizeAt?: number
  readonly overscan?: number
  readonly getItemKey?: (item: Item, index: number) => string | number
}

/**
 * A shared fixed-row virtualizer for result collections.  It intentionally
 * uses the app-content scroller rather than creating nested scroll regions,
 * which keeps wheel momentum and route-scroll restoration native on macOS.
 */
export function useFixedRowVirtualizer<Item>(
  items: ComputedRef<readonly Item[]>,
  {
    rowHeight,
    virtualizeAt = 96,
    overscan = 8,
    getItemKey = (_item: Item, index: number) => index,
  }: FixedRowVirtualizerOptions<Item>,
) {
  const listRoot = ref<ScrollElement | null>(null)
  const scrollElement = shallowRef<ScrollElement | null>(null)
  const scrollMargin = ref(0)
  const virtualizerActive = ref(true)
  let resizeObserver: globalThis.ResizeObserver | null = null

  const isVirtualized = computed(() => items.value.length >= virtualizeAt)

  function resolveScrollElement(): ScrollElement | null {
    return (
      listRoot.value?.closest<ScrollElement>('.app-content') ??
      document.querySelector<ScrollElement>('.app-content')
    )
  }

  const virtualizer = useVirtualizer(
    computed(() => ({
      count: items.value.length,
      enabled: isVirtualized.value,
      getScrollElement: () =>
        virtualizerActive.value ? (scrollElement.value ?? resolveScrollElement()) : null,
      estimateSize: () => rowHeight,
      getItemKey: (index: number) => {
        const item = items.value[index]
        return item === undefined ? index : getItemKey(item, index)
      },
      overscan,
      scrollMargin: scrollMargin.value,
    })),
  )

  const staticRows = computed<readonly FixedVirtualRow[]>(() =>
    items.value.map((item, index) => ({
      key: getItemKey(item, index),
      index,
      start: index * rowHeight,
    })),
  )
  const visibleRows = computed<readonly FixedVirtualRow[]>(() =>
    isVirtualized.value ? virtualizer.value.getVirtualItems() : staticRows.value,
  )
  const listStyle = computed<Record<string, string>>(() =>
    isVirtualized.value ? { height: `${virtualizer.value.getTotalSize()}px` } : {},
  )

  function rowStyle(row: FixedVirtualRow): Record<string, string> {
    return isVirtualized.value ? { '--virtual-row-y': `${row.start - scrollMargin.value}px` } : {}
  }

  function updateScrollMargin(): void {
    if (!isVirtualized.value || !virtualizerActive.value) return
    const root = listRoot.value
    const scroller = scrollElement.value
    if (!root || !scroller) return
    scrollMargin.value =
      root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  }

  function refreshVirtualizer(): void {
    if (!isVirtualized.value || !virtualizerActive.value) return
    virtualizer.value._willUpdate()
    updateScrollMargin()
    virtualizer.value.measure()
  }

  function observeGeometry(): void {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (!isVirtualized.value || !virtualizerActive.value) return
    if (typeof globalThis.ResizeObserver === 'undefined') return
    resizeObserver = new globalThis.ResizeObserver(updateScrollMargin)
    if (scrollElement.value) resizeObserver.observe(scrollElement.value)
    if (listRoot.value) resizeObserver.observe(listRoot.value)
  }

  async function bindVirtualizer(): Promise<void> {
    await nextTick()
    scrollElement.value = resolveScrollElement()
    refreshVirtualizer()
    observeGeometry()
  }

  onMounted(() => void bindVirtualizer())
  onActivated(() => {
    virtualizerActive.value = true
    void bindVirtualizer()
  })
  onDeactivated(() => {
    virtualizerActive.value = false
    resizeObserver?.disconnect()
    resizeObserver = null
    // Drop the virtualizer's shared-scroller observer while the page is kept
    // alive. It is rebound before the route becomes visible again.
    virtualizer.value._willUpdate()
  })
  onBeforeUnmount(() => resizeObserver?.disconnect())

  watch(items, () => void bindVirtualizer(), { flush: 'post' })
  watch(isVirtualized, () => void bindVirtualizer(), { flush: 'post' })

  return {
    listRoot,
    isVirtualized,
    visibleRows,
    listStyle,
    rowStyle,
  }
}
