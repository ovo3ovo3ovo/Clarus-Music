import { createApp, defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
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
    expect(image?.getAttribute('src')).toContain('param=1600y1600')

    image?.dispatchEvent(new Event('error'))
    await nextTick()
    expect(image?.getAttribute('src')).toContain('clarus_retry=1')

    image?.dispatchEvent(new Event('error'))
    await nextTick()
    expect(image?.getAttribute('src')).toContain('param=1024y1024')
    expect(image?.getAttribute('data-cover-state')).toBe('loading')
    app.unmount()
  })
})
