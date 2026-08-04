import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { installRouteScrollManager } from './route-scroll'

describe('route scroll manager', () => {
  it('restores a route position when navigating back', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/album/1', component: { template: '<div />' } },
      ],
    })
    await router.push('/')
    await router.isReady()

    const container = {
      scrollTop: 240,
      scrollTo: vi.fn(({ top }: { top: number }) => {
        container.scrollTop = top
      }),
    }
    const remove = installRouteScrollManager(router, () => container)

    await router.push('/album/1')
    await nextTick()
    expect(container.scrollTop).toBe(0)

    container.scrollTop = 520
    await router.push('/')
    await nextTick()
    expect(container.scrollTop).toBe(240)
    expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 240, behavior: 'auto' })

    remove()
  })
})
