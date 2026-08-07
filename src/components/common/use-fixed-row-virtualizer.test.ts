/* eslint-disable vue/one-component-per-file -- fixture components exercise the composable lifecycle. */
import { computed, createApp, defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFixedRowVirtualizer } from './use-fixed-row-virtualizer'

const { virtualizerOptions, virtualizerWillUpdate } = vi.hoisted(() => ({
  virtualizerOptions: vi.fn(),
  virtualizerWillUpdate: vi.fn(),
}))

vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (options: unknown) => {
    virtualizerOptions(options)
    return {
      value: {
        getVirtualItems: () => [
          { key: 'first', index: 0, start: 0 },
          { key: 'second', index: 1, start: 54 },
        ],
        getTotalSize: () => 108,
        _willUpdate: virtualizerWillUpdate,
        measure: () => undefined,
      },
    }
  },
}))

const FixedRowFixture = defineComponent({
  props: {
    items: { type: Array as () => readonly number[], required: true },
  },
  setup(props) {
    const virtualRows = useFixedRowVirtualizer(
      computed(() => props.items),
      {
        rowHeight: 54,
        getItemKey: (item) => item,
      },
    )
    return () =>
      h(
        'div',
        {
          ref: virtualRows.listRoot,
          class: ['fixed-row-fixture', { 'is-virtualized': virtualRows.isVirtualized.value }],
          style: virtualRows.listStyle.value,
        },
        virtualRows.visibleRows.value.map((row) =>
          h(
            'article',
            {
              key: String(row.key),
              class: 'fixed-row',
              style: virtualRows.rowStyle(row),
            },
            String(props.items[row.index]),
          ),
        ),
      )
  },
})

function largeItems(): readonly number[] {
  return Array.from({ length: 96 }, (_, index) => index + 1)
}

function mountFixture(items: readonly number[]) {
  const scroller = document.createElement('main')
  scroller.className = 'app-content'
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
  scroller.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 1_200, bottom: 600, width: 1_200, height: 600 }) as DOMRect
  const root = document.createElement('div')
  scroller.append(root)
  document.body.append(scroller)
  const app = createApp(FixedRowFixture, { items })
  app.mount(root)
  return { app, root, scroller }
}

function latestVirtualizerOptions(): {
  value: { enabled: boolean; getScrollElement: () => Element | null }
} {
  return virtualizerOptions.mock.calls.at(-1)?.[0] as {
    value: { enabled: boolean; getScrollElement: () => Element | null }
  }
}

describe('useFixedRowVirtualizer', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('keeps short collections in native flow', async () => {
    const { app, root } = mountFixture([1, 2])
    await nextTick()

    const list = root.querySelector<HTMLElement>('.fixed-row-fixture')
    expect(list?.classList).not.toContain('is-virtualized')
    expect(list?.style.height).toBe('')
    expect(root.querySelectorAll('.fixed-row')).toHaveLength(2)
    expect(latestVirtualizerOptions().value.enabled).toBe(false)
    app.unmount()
  })

  it('mounts only virtual rows for 96 or more items', async () => {
    const { app, root } = mountFixture(largeItems())
    await nextTick()

    const list = root.querySelector<HTMLElement>('.fixed-row-fixture')
    expect(list?.classList).toContain('is-virtualized')
    expect(list?.style.height).toBe('108px')
    expect(root.querySelectorAll('.fixed-row')).toHaveLength(2)
    expect(latestVirtualizerOptions().value.enabled).toBe(true)
    app.unmount()
  })

  it('releases the app scroller while a cached page is inactive', async () => {
    const scroller = document.createElement('main')
    scroller.className = 'app-content'
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
    scroller.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 1_200, bottom: 600, width: 1_200, height: 600 }) as DOMRect
    const root = document.createElement('div')
    scroller.append(root)
    document.body.append(scroller)
    const active = ref(true)
    const app = createApp({
      setup() {
        return () =>
          h(KeepAlive, null, {
            default: () => (active.value ? h(FixedRowFixture, { items: largeItems() }) : h('div')),
          })
      },
    })
    app.mount(root)
    await nextTick()
    await nextTick()
    expect(latestVirtualizerOptions().value.getScrollElement()).toBe(scroller)

    virtualizerWillUpdate.mockClear()
    active.value = false
    await nextTick()
    expect(latestVirtualizerOptions().value.getScrollElement()).toBeNull()
    expect(virtualizerWillUpdate).toHaveBeenCalledOnce()
    app.unmount()
  })
})
