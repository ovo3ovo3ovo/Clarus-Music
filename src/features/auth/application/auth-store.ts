import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { AuthSession } from '../domain/auth'
import { nativeAuthGateway, type AuthGateway } from '../infrastructure/native-auth'

const signedOut: AuthSession = { authenticated: false, user: null }

export function createAuthStore(gateway: AuthGateway = nativeAuthGateway) {
  return defineStore('auth', () => {
    const session = shallowRef<AuthSession>(signedOut)
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
        const restored = await gateway.restoreSession(controller.signal)
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
        await gateway.logout(controller.signal)
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
