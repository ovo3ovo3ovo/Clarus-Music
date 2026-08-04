import { invoke } from '@tauri-apps/api/core'
import { desktop } from '@/platform/desktop'
import { cloneSettings, defaultSettings, type AppSettings } from '../domain/settings'

export interface SettingsGateway {
  load(): Promise<AppSettings>
  save(settings: AppSettings): Promise<void>
}

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
