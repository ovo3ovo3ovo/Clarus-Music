import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  createRouteScrollPositionStore,
  installRouteScrollManager,
  MAX_ROUTE_SCROLL_POSITIONS,
} from './route-scroll'

describe('route scroll manager', () => {
  it('bounds retained route positions while refreshing recently used entries', () => {
    const positions = createRouteScrollPositionStore(3)
    positions.set('/one', 10)
    positions.set('/two', 20)
    positions.set('/three', 30)
    expect(positions.size()).toBe(3)

    expect(positions.get('/one')).toBe(10)
    positions.set('/four', 40)

    expect(positions.get('/two')).toBeUndefined()
    expect(positions.get('/one')).toBe(10)
    expect(positions.size()).toBe(3)
  })

  it('keeps a bounded retain budget across a large fullPath cohort', () => {
    const positions = createRouteScrollPositionStore()
    for (let index = 0; index < 1_000; index += 1) {
      positions.set(
        `/search?q=term-${index}&page=${index % 17}#detail-${index}`,
        index,
      )
    }

    expect(positions.size()).toBe(MAX_ROUTE_SCROLL_POSITIONS)
    expect(positions.get('/search?q=term-0&page=0#detail-0')).toBeUndefined()
    expect(positions.get('/search?q=term-999&page=13#detail-999')).toBe(999)
  })

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
