import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { performanceAvatarUrl, validatedLoopbackOrigin } from '@/performance/runtime-config'
import type { AuthSession } from '../domain/auth'
import { nativeAuthGateway, type AuthGateway } from '../infrastructure/native-auth'

const signedOut: AuthSession = { authenticated: false, user: null }

export type AuthRuntimeMode = 'normal' | 'performance'

export type AuthRuntimeConfig =
  Readonly<{ mode: 'normal' }> | Readonly<{ mode: 'performance'; avatarOrigin: string }>

let authRuntimeConfig: AuthRuntimeConfig = { mode: 'normal' }

function performanceSession(avatarOrigin: string): AuthSession {
  return {
    authenticated: true,
    user: {
      userId: 900_001,
      nickname: 'Clarus Performance Fixture',
      avatarUrl: performanceAvatarUrl(validatedLoopbackOrigin(avatarOrigin)),
      signature: 'offline fixture',
      vipType: 0,
    },
  }
}

/**
 * The self-runner is an offline fixture process, not a second kind of user
 * account. Configure its deterministic authenticated surface before Pinia
 * creates the auth store so daily-songs exercises the same route and view as a
 * normal signed-in client without touching Keychain or cookies.
 */
export function configureAuthRuntime(config: AuthRuntimeConfig): void
export function configureAuthRuntime(mode: AuthRuntimeMode, avatarOrigin?: string): void
export function configureAuthRuntime(
  configOrMode: AuthRuntimeConfig | AuthRuntimeMode,
  avatarOrigin?: string,
): void {
  if (typeof configOrMode === 'string') {
    if (configOrMode === 'normal') {
      authRuntimeConfig = { mode: 'normal' }
      return
    }
    if (avatarOrigin === undefined) {
      throw new Error('Performance authentication requires the fixture loopback origin')
    }
    authRuntimeConfig = {
      mode: 'performance',
      avatarOrigin: validatedLoopbackOrigin(avatarOrigin),
    }
    return
  }
  authRuntimeConfig =
    configOrMode.mode === 'performance'
      ? { mode: 'performance', avatarOrigin: validatedLoopbackOrigin(configOrMode.avatarOrigin) }
      : configOrMode
}

const performanceAuthGateway: AuthGateway = {
  beginQrLogin: async () => {
    throw new Error('QR login is unavailable in the performance fixture')
  },
  checkQrLogin: async () => ({ status: 'expired', message: 'Performance fixture is offline' }),
  restoreSession: async () => {
    if (authRuntimeConfig.mode !== 'performance') {
      throw new Error('Performance authentication is not configured')
    }
    return performanceSession(authRuntimeConfig.avatarOrigin)
  },
  logout: async () => ({ remoteLogoutSucceeded: true }),
}

function defaultAuthGateway(): AuthGateway {
  return authRuntimeConfig.mode === 'performance' ? performanceAuthGateway : nativeAuthGateway
}

export function createAuthStore(gateway?: AuthGateway) {
  return defineStore('auth', () => {
    const resolvedGateway = gateway ?? defaultAuthGateway()
    const session = shallowRef<AuthSession>(
      authRuntimeConfig.mode === 'performance'
        ? performanceSession(authRuntimeConfig.avatarOrigin)
        : signedOut,
    )
    const restoring = shallowRef(false)
    const error = shallowRef<string | null>(null)
    let restoreController: AbortController | null = null

    async function restore(): Promise<AuthSession> {
      restoreController?.abort('Authentication restore superseded')
      const controller = new AbortController()
      restoreController = controller
      restoring.value = true
      error.value = null
      try {
        const restored = await resolvedGateway.restoreSession(controller.signal)
        session.value = restored
        return restored
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          error.value = reason instanceof Error ? reason.message : String(reason)
        }
        return session.value
      } finally {
        if (restoreController === controller) restoring.value = false
      }
    }

    async function logout(): Promise<void> {
      restoreController?.abort('Logging out')
      const controller = new AbortController()
      error.value = null
      try {
        await resolvedGateway.logout(controller.signal)
      } catch (reason) {
        error.value = reason instanceof Error ? reason.message : String(reason)
        throw reason
      } finally {
        session.value = signedOut
      }
    }

    function dispose(): void {
      restoreController?.abort('Authentication store disposed')
    }

    return { session, restoring, error, restore, logout, dispose }
  })
}

export const useAuthStore = createAuthStore()
