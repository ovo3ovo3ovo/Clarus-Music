/* eslint-disable vue/one-component-per-file -- test-only host components exercise CoverImage. */
import { createApp, defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CoverImage from './CoverImage.vue'

async function mountCover(attrs = '') {
  const Host = defineComponent({
    components: { CoverImage },
    template: `<CoverImage source="https://img.test/cover.jpg" :width="1024" alt="cover" ${attrs} />`,
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(Host)
  app.mount(root)
  await nextTick()
  return { app, root }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('CoverImage', () => {
  it('renders a lazy image by default and honors an explicit loading value', async () => {
    const defaultCover = await mountCover()
    expect(defaultCover.root.querySelector('img')?.getAttribute('loading')).toBe('lazy')
    defaultCover.app.unmount()

    const eagerCover = await mountCover('loading="eager"')
    expect(eagerCover.root.querySelector('img')?.getAttribute('loading')).toBe('eager')
    eagerCover.app.unmount()
  })

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

  it('changes its request only when the artwork source or requested dimensions change', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const source = ref('https://img.test/first.jpg')
    const width = ref(40)
    const viewportUnload = ref(true)
    const app = createApp({
      setup() {
        return () =>
          h(CoverImage, {
            source: source.value,
            width: width.value,
            role: 'row',
            options: { pixelRatio: 1 },
            viewportUnload: viewportUnload.value,
            alt: 'cover',
          })
      },
    })
    app.mount(root)
    await nextTick()

    const image = root.querySelector<HTMLImageElement>('img')
    const firstSource = image?.getAttribute('src')
    expect(firstSource).toContain('/first.jpg')
    expect(firstSource).toContain('param=96y96')

    // The legacy prop is compatibility-only and cannot restart a request.
    viewportUnload.value = false
    await nextTick()
    expect(image?.getAttribute('src')).toBe(firstSource)

    source.value = 'https://img.test/second.jpg'
    await nextTick()
    expect(image?.getAttribute('src')).toContain('/second.jpg')
    expect(image?.getAttribute('src')).toContain('param=96y96')

    width.value = 100
    await nextTick()
    expect(image?.getAttribute('src')).toContain('/second.jpg')
    expect(image?.getAttribute('src')).toContain('param=128y128')
    app.unmount()
  })

  it('keeps a loaded src when an observer reports the image offscreen', async () => {
    const observerState: {
      callback: ((entries: IntersectionObserverEntry[]) => void) | null
      instances: number
    } = { callback: null, instances: 0 }
    class FakeIntersectionObserver {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        observerState.instances += 1
        observerState.callback = callback
      }

      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

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

    const image = root.querySelector<HTMLImageElement>('img')
    image?.dispatchEvent(new Event('load'))
    await nextTick()
    const loadedSource = image?.getAttribute('src')
    expect(loadedSource).toContain('param=96y96')
    expect(image?.getAttribute('data-cover-state')).toBe('loaded')

    observerState.callback?.([{ isIntersecting: false } as IntersectionObserverEntry])
    await nextTick()
    expect(observerState.instances).toBe(0)
    expect(image?.getAttribute('src')).toBe(loadedSource)
    expect(image?.getAttribute('data-cover-state')).toBe('loaded')
    app.unmount()
  })

  it('keeps a loaded src during ordinary scrolling', async () => {
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

    const image = root.querySelector<HTMLImageElement>('img')
    image?.dispatchEvent(new Event('load'))
    await nextTick()
    const loadedSource = image?.getAttribute('src')
    root.querySelector<HTMLElement>('.app-content')?.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(image?.getAttribute('src')).toBe(loadedSource)
    expect(image?.getAttribute('data-cover-state')).toBe('loaded')
    app.unmount()
  })

  it('keeps the same loaded source across KeepAlive deactivation and activation', async () => {
    const root = document.createElement('main')
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
                    loading: 'eager',
                    alt: 'cover',
                  })
                : h('div'),
          })
      },
    })
    app.mount(root)
    await nextTick()

    const image = root.querySelector<HTMLImageElement>('img')
    image?.dispatchEvent(new Event('load'))
    await nextTick()
    const loadedSource = image?.getAttribute('src')
    expect(loadedSource).toContain('param=96y96')

    active.value = false
    await nextTick()
    expect(image?.getAttribute('src')).toBe(loadedSource)
    expect(image?.getAttribute('data-cover-state')).toBe('loaded')
    expect(image?.getAttribute('loading')).toBe('eager')

    active.value = true
    await nextTick()
    const restoredImage = root.querySelector<HTMLImageElement>('img')
    expect(restoredImage).toBe(image)
    expect(restoredImage?.getAttribute('src')).toBe(loadedSource)
    expect(restoredImage?.getAttribute('data-cover-state')).toBe('loaded')
    expect(restoredImage?.getAttribute('loading')).toBe('eager')
    app.unmount()
  })

  it('does not replace a loaded src when the document is backgrounded', async () => {
    const { app, root } = await mountCover()
    const image = root.querySelector<HTMLImageElement>('img')
    image?.dispatchEvent(new Event('load'))
    await nextTick()
    const loadedSource = image?.getAttribute('src')

    const originalVisibility = document.visibilityState
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      await nextTick()
      expect(image?.getAttribute('src')).toBe(loadedSource)
      expect(image?.getAttribute('data-cover-state')).toBe('loaded')
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      })
      app.unmount()
    }
  })

  it('leaves the source intact when the component truly unmounts', async () => {
    const { app, root } = await mountCover()
    const image = root.querySelector<HTMLImageElement>('img')
    const source = image?.getAttribute('src')

    app.unmount()

    // The node is detached by Vue; no transparent replacement is needed to
    // release it, and a retained reference must not observe a src rewrite.
    expect(image?.getAttribute('src')).toBe(source)
  })
})
