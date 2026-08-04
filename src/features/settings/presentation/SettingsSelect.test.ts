import { createApp, defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import SettingsSelect from './SettingsSelect.vue'

async function mountSelect(disabled = false) {
  const Host = defineComponent({
    components: { SettingsSelect },
    setup() {
      const value = ref<string | number>('standard')
      return { disabled, value }
    },
    template: `
      <SettingsSelect
        v-model="value"
        label="Quality"
        :disabled="disabled"
        :options="[
          { value: 'standard', label: 'Standard' },
          { value: 'lossless', label: 'Lossless' }
        ]"
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

describe('SettingsSelect', () => {
  it('opens an animated option menu and commits the selected value', async () => {
    const { app, root } = await mountSelect()
    root.querySelector<HTMLButtonElement>('.settings-select__trigger')?.click()
    await nextTick()

    const options = root.querySelectorAll<HTMLButtonElement>('.settings-select__option')
    expect(options).toHaveLength(2)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')

    options[1]?.click()
    await nextTick()
    expect(root.querySelector('.settings-select__trigger')?.textContent).toContain('Lossless')
    expect(root.querySelector('.settings-select__trigger')?.getAttribute('aria-expanded')).toBe(
      'false',
    )
    app.unmount()
  })

  it('does not open while disabled', async () => {
    const { app, root } = await mountSelect(true)
    root.querySelector<HTMLButtonElement>('.settings-select__trigger')?.click()
    await nextTick()
    expect(root.querySelector('.settings-select__menu')).toBeNull()
    app.unmount()
  })
})
