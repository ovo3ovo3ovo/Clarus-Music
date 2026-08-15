import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../domain/settings'
import {
  configureSettingsRuntime,
  nativeSettingsGateway,
  runtimeSettingsGateway,
} from './native-settings'

afterEach(() => configureSettingsRuntime('normal'))

describe('settings runtime gateway selection', () => {
  it('uses fresh deterministic defaults entirely in memory for performance runs', async () => {
    configureSettingsRuntime('performance')
    const gateway = runtimeSettingsGateway()

    const first = await gateway.load()
    await gateway.save({
      ...first,
      proxy: { ...first.proxy, server: 'performance-only' },
      shortcuts: first.shortcuts.map((shortcut, index) =>
        index === 0 ? { ...shortcut, name: 'mutated' } : shortcut,
      ),
    })
    const second = await gateway.load()

    expect(gateway).not.toBe(nativeSettingsGateway)
    expect(first).not.toBe(defaultSettings)
    expect(second).not.toBe(first)
    expect(second).toEqual(defaultSettings)
    expect(second.proxy).not.toBe(defaultSettings.proxy)
    expect(second.shortcuts).not.toBe(defaultSettings.shortcuts)
    expect(second.shortcuts[0]).not.toBe(defaultSettings.shortcuts[0])
  })

  it('resets to the unchanged native gateway for normal runtime', () => {
    configureSettingsRuntime('performance')
    expect(runtimeSettingsGateway()).not.toBe(nativeSettingsGateway)

    configureSettingsRuntime({ mode: 'normal' })
    expect(runtimeSettingsGateway()).toBe(nativeSettingsGateway)
  })
})
