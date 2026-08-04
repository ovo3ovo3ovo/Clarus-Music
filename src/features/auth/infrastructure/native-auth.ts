import { invoke } from '@tauri-apps/api/core'
import { desktop } from '@/platform/desktop'
import { cancellableInvoke, type InvokeCommand } from '@/platform/native-ipc'
import type { AuthSession, LogoutResult, QrLogin, QrLoginCheck } from '../domain/auth'

export interface AuthGateway {
  beginQrLogin(signal?: AbortSignal): Promise<QrLogin>
  checkQrLogin(key: string, signal?: AbortSignal): Promise<QrLoginCheck>
  restoreSession(signal?: AbortSignal): Promise<AuthSession>
  logout(signal?: AbortSignal): Promise<LogoutResult>
}

export class NativeAuthGateway implements AuthGateway {
  private readonly invokeCommand: InvokeCommand
  private readonly createRequestId: () => string
  private readonly isDesktop: boolean

  constructor(
    invokeCommand: InvokeCommand = invoke,
    createRequestId: () => string = () => crypto.randomUUID(),
    isDesktop = desktop.isDesktop,
  ) {
    this.invokeCommand = invokeCommand
    this.createRequestId = createRequestId
    this.isDesktop = isDesktop
  }

  beginQrLogin(signal?: AbortSignal): Promise<QrLogin> {
    return this.cancellableInvoke('begin_qr_login', {}, signal)
  }

  checkQrLogin(key: string, signal?: AbortSignal): Promise<QrLoginCheck> {
    return this.cancellableInvoke('check_qr_login', { key }, signal)
  }

  restoreSession(signal?: AbortSignal): Promise<AuthSession> {
    if (!this.isDesktop) return Promise.resolve({ authenticated: false, user: null })
    return this.cancellableInvoke('restore_session', {}, signal)
  }

  logout(signal?: AbortSignal): Promise<LogoutResult> {
    if (!this.isDesktop) return Promise.resolve({ remoteLogoutSucceeded: true })
    return this.cancellableInvoke('logout', {}, signal)
  }

  private async cancellableInvoke<T>(
    command: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return cancellableInvoke<T>({
      invokeCommand: this.invokeCommand,
      createRequestId: this.createRequestId,
      isDesktop: this.isDesktop,
      desktopError: 'Account authentication requires the desktop app',
      abortMessage: 'Authentication request aborted',
      command,
      args,
      signal,
    })
  }
}

export const nativeAuthGateway = new NativeAuthGateway()
