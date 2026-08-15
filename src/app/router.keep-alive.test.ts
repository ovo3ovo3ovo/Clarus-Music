import { describe, expect, it } from 'vitest'
import { router } from './router'

describe('artist route cache metadata', () => {
  it('marks artist navigation as one reusable surface', () => {
    const artistRoute = router.getRoutes().find((route) => route.name === 'artist')

    expect(artistRoute?.meta).toMatchObject({ keepAlive: true, cacheKey: 'artist' })
  })
})
