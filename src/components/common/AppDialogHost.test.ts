import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import AppDialogHost from './AppDialogHost.vue'
import { appDialogRequest, resolveAppDialog, showAppConfirm } from '@/platform/app-dialogs'

let app: ReturnType<typeof createApp> | null = null
let root: HTMLDivElement | null = null

afterEach(() => {
  resolveAppDialog(false)
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

async function mountHost(): Promise<void> {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(AppDialogHost)
  app.mount(root)
  await nextTick()
}

describe('AppDialogHost', () => {
  it('resolves the hide action from the visible cancel button', async () => {
    const result = showAppConfirm({
      title: '退出 Clarus Music？',
      message: '关闭应用，还是继续在后台运行？',
      confirmLabel: '退出应用',
      cancelLabel: '隐藏到后台',
      tone: 'danger',
    })
    await mountHost()

    document.body.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')?.click()

    await expect(result).resolves.toBe(false)
    expect(appDialogRequest.value).toBeNull()
  })

  it('resolves the exit action from the visible confirm button', async () => {
    const result = showAppConfirm({
      title: '退出 Clarus Music？',
      message: '关闭应用，还是继续在后台运行？',
      confirmLabel: '退出应用',
      cancelLabel: '隐藏到后台',
      tone: 'danger',
    })
    await mountHost()

    document.body.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]')?.click()

    await expect(result).resolves.toBe(true)
    expect(appDialogRequest.value).toBeNull()
  })
})
