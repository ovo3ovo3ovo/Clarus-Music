/* eslint-disable vue/one-component-per-file -- test-only host components exercise CoverImage. */
import { createApp, defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CoverImage from './CoverImage.vue'

async function mountCover() {
  const Host = defineComponent({
    components: { CoverImage },
    template: '<CoverImage source="https://img.test/cover.jpg" :width="1024" alt="cover" />',
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(Host)
  app.mount(root)
  await nextTick()
  return { app, root }
}

afterEach(() => document.body.replaceChildren())

describe('CoverImage', () => {
  it('retries the primary URL and then falls back to another artwork size', async () => {
    const { app, root } = await mountCover()
    const image = root.querySelector<HTMLImageElement>('img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toContain('param=1024y1024')

    image?.dispatchEvent(new Event('error'))
    await nextTick()
    expect(image?.getAttribute('src')).toContain('clarus_retry=1')

    image?.dispatchEvent(new Event('error'))
    await nextTick()
    expect(image?.getAttribute('src')).toContain('param=768y768')
    expect(image?.getAttribute('data-cover-state')).toBe('loading')
    app.unmount()
  })

  it('detaches an offscreen list cover while keeping its layout slot', async () => {
    const observerState: { callback: ((entries: IntersectionObserverEntry[]) => void) | null } = {
      callback: null,
    }
    class FakeIntersectionObserver {
      constructor(next: (entries: IntersectionObserverEntry[]) => void) {
        observerState.callback = next
      }

      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    try {
      const Host = defineComponent({
        components: { CoverImage },
        template:
          '<div class="app-content"><CoverImage source="https://img.test/cover.jpg" :width="40" role="row" viewport-unload alt="cover" /></div>',
      })
      const root = document.createElement('div')
      document.body.append(root)
      const app = createApp(Host)
      app.mount(root)
      await nextTick()
      await nextTick()
      const image = root.querySelector<HTMLImageElement>('img')
      observerState.callback?.([{ isIntersecting: true } as IntersectionObserverEntry])
      await nextTick()
      expect(image?.getAttribute('src')).toContain('param=96y96')

      observerState.callback?.([{ isIntersecting: false } as IntersectionObserverEntry])
      await nextTick()
      expect(image?.getAttribute('src')).toMatch(/^data:image\/gif/)
      expect(image?.getAttribute('data-cover-state')).toBe('idle')

      observerState.callback?.([{ isIntersecting: true } as IntersectionObserverEntry])
      await nextTick()
      expect(image?.getAttribute('src')).toContain('param=96y96')
      app.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('releases a viewport-managed image while its kept-alive page is hidden', async () => {
    class FakeIntersectionObserver {
      private readonly callback: (entries: IntersectionObserverEntry[]) => void

      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        this.callback = callback
      }

      observe(): void {
        this.callback([{ isIntersecting: true } as IntersectionObserverEntry])
      }

      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    try {
      const root = document.createElement('main')
      root.className = 'app-content'
      document.body.append(root)
      const active = ref(true)
      const app = createApp({
        setup() {
          return () =>
            h(KeepAlive, null, {
              default: () =>
                active.value
                  ? h(CoverImage, {
                      source: 'https://img.test/cover.jpg',
                      width: 40,
                      role: 'row',
                      viewportUnload: true,
                      alt: 'cover',
                    })
                  : h('div'),
            })
        },
      })
      app.mount(root)
      await nextTick()
      await nextTick()
      const image = root.querySelector<HTMLImageElement>('img')
      expect(image?.getAttribute('src')).toContain('param=96y96')

      active.value = false
      await nextTick()
      expect(image?.getAttribute('src')).toMatch(/^data:image\/gif/)

      active.value = true
      await nextTick()
      await nextTick()
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
      expect(root.querySelector<HTMLImageElement>('img')?.getAttribute('src')).toContain(
        'param=96y96',
      )
      app.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
