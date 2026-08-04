import { invoke } from '@tauri-apps/api/core'

export interface RuntimeInfo {
  readonly appName: string
  readonly appVersion: string
  readonly architecture: string
  readonly operatingSystem: string
}

export interface DesktopAdapter {
  readonly isDesktop: boolean
  getRuntimeInfo(): Promise<RuntimeInfo>
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

const browserRuntimeInfo: RuntimeInfo = {
  appName: 'Clarus Music',
  appVersion: 'web-dev',
  architecture: navigator.platform,
  operatingSystem: navigator.userAgent,
}

export const desktop: DesktopAdapter = {
  isDesktop: isTauriRuntime(),
  async getRuntimeInfo() {
    return this.isDesktop ? invoke<RuntimeInfo>('runtime_info') : browserRuntimeInfo
  },
}
