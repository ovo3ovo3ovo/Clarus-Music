import { invoke } from '@tauri-apps/api/core'
import { desktop } from '@/platform/desktop'
import { cloneSettings, defaultSettings, type AppSettings } from '../domain/settings'

export interface SettingsGateway {
  load(): Promise<AppSettings>
  save(settings: AppSettings): Promise<void>
}

export type SettingsRuntimeMode = 'normal' | 'performance'

export type SettingsRuntimeConfig = Readonly<{ mode: SettingsRuntimeMode }>

let settingsRuntimeMode: SettingsRuntimeMode = 'normal'

export const nativeSettingsGateway: SettingsGateway = {
  load() {
    return desktop.isDesktop
      ? invoke<AppSettings>('load_settings')
      : Promise.resolve(cloneSettings(defaultSettings))
  },
  save(settings) {
    return desktop.isDesktop ? invoke<void>('save_settings', { settings }) : Promise.resolve()
  },
}

// Performance runs must never inherit or persist a user's preferences. Every
// load starts from an independent defaults snapshot and writes are deliberately
// discarded in memory.
const performanceSettingsGateway: SettingsGateway = {
  load: () => Promise.resolve(cloneSettings(defaultSettings)),
  save: () => Promise.resolve(),
}

/**
 * Choose the settings boundary before Pinia creates the app-wide store.
 * Normal runtime remains the default, preserving the native gateway exactly.
 */
export function configureSettingsRuntime(config: SettingsRuntimeConfig): void
export function configureSettingsRuntime(mode: SettingsRuntimeMode): void
export function configureSettingsRuntime(
  configOrMode: SettingsRuntimeConfig | SettingsRuntimeMode,
): void {
  settingsRuntimeMode = typeof configOrMode === 'string' ? configOrMode : configOrMode.mode
}

/** Resolve the gateway lazily so main can configure performance mode before store creation. */
export function runtimeSettingsGateway(): SettingsGateway {
  return settingsRuntimeMode === 'performance' ? performanceSettingsGateway : nativeSettingsGateway
}
