import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { setAppLocale } from '@/app/i18n'
import { nativeAudioCacheGateway } from '@/features/cache/infrastructure/native-audio-cache'
import {
  cloneSettings,
  defaultSettings,
  type AppLocale,
  type AppSettings,
  type AppTheme,
  type LyricFontSize,
} from '../domain/settings'
import { nativeSettingsGateway, type SettingsGateway } from '../infrastructure/native-settings'
import { CoalescedSettingsWriter } from './coalesced-settings-writer'

function resolvedLocale(locale: AppLocale): Exclude<AppLocale, 'auto'> {
  if (locale !== 'auto') return locale
  const browserLocale = navigator.language
  if (browserLocale === 'zh-TW' || browserLocale === 'zh-HK') return 'zh-TW'
  if (browserLocale.startsWith('zh')) return 'zh-CN'
  if (browserLocale.startsWith('tr')) return 'tr'
  return 'en'
}

export function normalizeAppTheme(value: unknown): AppTheme {
  // `dark` and `auto` were former persisted values. Return to the original
  // pure-black canvas instead of guessing a new style during migration.
  if (value === 'oled' || value === 'dark' || value === 'auto') return 'oled'
  // Missing or unrecognized values use the current warm-light default.
  return 'light'
}

/**
 * The former 16/22/28px presets were too small for the lyrics layout. Keep
 * existing settings readable by promoting every retired preset to the new
 * 36px minimum while preserving the larger current presets.
 */
export function normalizeLyricFontSize(value: unknown): LyricFontSize {
  if (value === 44 || value === 52 || value === 60) return value
  return 36
}

function normalizeVisualSettings(settings: AppSettings): AppSettings {
  // Drop the retired independent themeColor setting when a legacy settings file is saved.
  const current = { ...settings } as AppSettings & { themeColor?: unknown }
  Reflect.deleteProperty(current, 'themeColor')
  return {
    ...current,
    appearance: normalizeAppTheme(settings.appearance),
    lyricFontSize: normalizeLyricFontSize(settings.lyricFontSize),
  }
}

function applyVisualSettings(settings: AppSettings): void {
  document.documentElement.dataset.theme = settings.appearance
  delete document.documentElement.dataset.themeColor
  const locale = resolvedLocale(settings.locale)
  document.documentElement.lang = locale
  setAppLocale(locale)
}

export function createSettingsStore(gateway: SettingsGateway = nativeSettingsGateway) {
  return defineStore('settings', () => {
    const settings = shallowRef<AppSettings>(cloneSettings(defaultSettings))
    const initialized = shallowRef(false)
    const persistenceError = shallowRef<string | null>(null)
    let initialization: Promise<void> | null = null

    const writer = new CoalescedSettingsWriter<AppSettings>({
      clone: cloneSettings,
      save: (snapshot) => gateway.save(snapshot),
      onError(error) {
        persistenceError.value = error instanceof Error ? error.message : String(error)
      },
    })

    function apply(): void {
      applyVisualSettings(settings.value)
      nativeAudioCacheGateway.configure(settings.value.automaticallyCacheSongs)
    }

    async function initialize(): Promise<void> {
      if (initialization !== null) return initialization
      initialization = gateway
        .load()
        .then((loaded) => {
          settings.value = normalizeVisualSettings(cloneSettings(loaded))
        })
        .catch((error: unknown) => {
          persistenceError.value = error instanceof Error ? error.message : String(error)
          settings.value = normalizeVisualSettings(cloneSettings(defaultSettings))
        })
        .finally(() => {
          initialized.value = true
          apply()
        })
      return initialization
    }

    function update(patch: Partial<Omit<AppSettings, 'schemaVersion'>>): void {
      settings.value = normalizeVisualSettings({ ...settings.value, ...patch })
      persistenceError.value = null
      apply()
      writer.schedule(settings.value)
    }

    async function flush(): Promise<void> {
      try {
        await writer.flush()
      } catch (error) {
        persistenceError.value = error instanceof Error ? error.message : String(error)
        throw error
      }
    }

    async function dispose(): Promise<void> {
      await writer.dispose()
    }

    return { settings, initialized, persistenceError, initialize, update, flush, dispose }
  })
}

export const useSettingsStore = createSettingsStore()
