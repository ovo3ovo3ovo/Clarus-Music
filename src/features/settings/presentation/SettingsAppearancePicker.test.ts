import { createApp, defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppTheme } from '../domain/settings'
import SettingsAppearancePicker, { type AppearanceOption } from './SettingsAppearancePicker.vue'

const options: readonly AppearanceOption[] = [
  { value: 'oled', label: 'Pure black' },
  { value: 'light', label: 'Light' },
]

async function mountAppearancePicker() {
  const Host = defineComponent({
    components: { SettingsAppearancePicker },
    setup() {
      const value = ref<AppTheme>('oled')
      return { options, value }
    },
    template: `
      <SettingsAppearancePicker
        v-model="value"
        label="Appearance"
        :options="options"
      />
    `,
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(Host)
  app.mount(root)
  await nextTick()
  return { app, root }
}

afterEach(() => document.body.replaceChildren())

describe('SettingsAppearancePicker', () => {
  it('presents a compact radio group and switches the selected theme', async () => {
    const { app, root } = await mountAppearancePicker()
    const choices = root.querySelectorAll<HTMLButtonElement>('[role="radio"]')

    expect(choices).toHaveLength(2)
    expect(choices[0]?.getAttribute('aria-checked')).toBe('true')

    choices[1]?.click()
    await nextTick()

    expect(choices[0]?.getAttribute('aria-checked')).toBe('false')
    expect(choices[1]?.getAttribute('aria-checked')).toBe('true')
    expect(choices[0]?.querySelector('.appearance-option__check')).toBeNull()
    app.unmount()
  })
})
