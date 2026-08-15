import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloneSettings, defaultSettings, type AppSettings } from '../domain/settings'
import { createSettingsStore, normalizeAppTheme, normalizeLyricFontSize } from './settings-store'
import {
  configureSettingsRuntime,
  nativeSettingsGateway,
  type SettingsGateway,
} from '../infrastructure/native-settings'

function gatewayFor(settings: AppSettings) {
  let lastSaved: AppSettings | null = null
  const save = vi.fn((snapshot: AppSettings) => {
    lastSaved = snapshot
    return Promise.resolve()
  })
  const gateway: SettingsGateway = {
    load: async () => cloneSettings(settings),
    save,
  }
  return { gateway, lastSaved: () => lastSaved, save }
}

afterEach(() => {
  vi.restoreAllMocks()
  configureSettingsRuntime('normal')
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-theme-color')
  document.documentElement.removeAttribute('lang')
})

describe('settings runtime isolation', () => {
  it('resolves performance mode when the store factory was defined before runtime setup', async () => {
    const createStore = createSettingsStore()
    const load = vi.spyOn(nativeSettingsGateway, 'load')
    const save = vi.spyOn(nativeSettingsGateway, 'save')
    configureSettingsRuntime('performance')
    const store = createStore(createPinia())

    await store.initialize()
    store.update({ locale: 'tr' })
    await store.flush()

    expect(load).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await store.dispose()
  })

  it('never loads or saves through the native gateway in performance mode', async () => {
    configureSettingsRuntime('performance')
    const load = vi.spyOn(nativeSettingsGateway, 'load')
    const save = vi.spyOn(nativeSettingsGateway, 'save')
    const store = createSettingsStore()(createPinia())

    await store.initialize()
    store.update({ locale: 'tr' })
    await store.flush()

    expect(store.settings).toMatchObject({ locale: 'tr' })
    expect(load).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await store.dispose()
  })

  it('continues to use the native gateway in normal mode after a performance reset', async () => {
    configureSettingsRuntime('performance')
    configureSettingsRuntime('normal')
    const loaded = { ...cloneSettings(defaultSettings), locale: 'zh-TW' as const }
    const load = vi.spyOn(nativeSettingsGateway, 'load').mockResolvedValue(loaded)
    const save = vi.spyOn(nativeSettingsGateway, 'save').mockResolvedValue()
    const store = createSettingsStore()(createPinia())

    await store.initialize()
    store.update({ locale: 'en' })
    await store.flush()

    expect(load).toHaveBeenCalledOnce()
    expect(store.settings.locale).toBe('en')
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
    await store.dispose()
  })
})

describe('settings appearance', () => {
  it('migrates former dark and auto values to the pure-black theme', () => {
    expect(normalizeAppTheme('dark')).toBe('oled')
    expect(normalizeAppTheme('auto')).toBe('oled')
    expect(normalizeAppTheme('violet')).toBe('light')
    expect(normalizeAppTheme('green')).toBe('light')
    expect(normalizeAppTheme(undefined)).toBe('light')
    expect(normalizeAppTheme('unknown')).toBe('light')
  })

  it('applies and persists a selected appearance while removing the retired color field', async () => {
    setActivePinia(createPinia())
    const legacy = {
      ...cloneSettings(defaultSettings),
      appearance: 'dark',
      themeColor: 'forest',
    } as unknown as AppSettings
    const { gateway, lastSaved, save } = gatewayFor(legacy)
    const store = createSettingsStore(gateway)()

    await store.initialize()

    expect(store.settings.appearance).toBe('oled')
    expect(document.documentElement.dataset.theme).toBe('oled')

    store.update({ appearance: 'oled' })
    await store.flush()

    expect(document.documentElement.dataset.theme).toBe('oled')
    const saved = lastSaved()
    expect(save).toHaveBeenCalledOnce()
    expect(saved).toMatchObject({ appearance: 'oled' })
    expect('themeColor' in (saved ?? {})).toBe(false)
    await store.dispose()
  })
})

describe('lyrics font size', () => {
  it('promotes retired presets and keeps the enlarged scale', () => {
    expect(normalizeLyricFontSize(16)).toBe(36)
    expect(normalizeLyricFontSize(22)).toBe(36)
    expect(normalizeLyricFontSize(28)).toBe(36)
    expect(normalizeLyricFontSize(36)).toBe(36)
    expect(normalizeLyricFontSize(44)).toBe(44)
    expect(normalizeLyricFontSize(52)).toBe(52)
    expect(normalizeLyricFontSize(60)).toBe(60)
  })
})
