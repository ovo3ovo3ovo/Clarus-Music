import { createPinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { configureAuthRuntime, useAuthStore } from './auth-store'

describe('auth runtime selection', () => {
  afterEach(() => configureAuthRuntime('normal'))

  it('starts the performance instance with a deterministic authenticated fixture', async () => {
    configureAuthRuntime('performance', 'http://127.0.0.1:43123')
    const store = useAuthStore(createPinia())

    expect(store.session.authenticated).toBe(true)
    expect(store.session.user?.userId).toBe(900_001)
    expect(store.session.user?.avatarUrl).toBe('http://127.0.0.1:43123/clarus-perf/avatar.png')
    await expect(store.restore()).resolves.toMatchObject({ authenticated: true })
  })

  it('keeps normal instances signed out until the native restore completes', () => {
    configureAuthRuntime('normal')
    const store = useAuthStore(createPinia())

    expect(store.session).toEqual({ authenticated: false, user: null })
    expect(store.restoring).toBe(false)
  })
})
