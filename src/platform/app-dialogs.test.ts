import { afterEach, describe, expect, it } from 'vitest'
import { appDialogRequest, resolveAppDialog, showAppAlert, showAppConfirm } from './app-dialogs'

afterEach(() => resolveAppDialog(false))

describe('app dialogs', () => {
  it('resolves confirmation choices through the shared host state', async () => {
    const result = showAppConfirm({
      title: 'Delete',
      message: 'Delete this item?',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      tone: 'danger',
    })

    expect(appDialogRequest.value).toMatchObject({ kind: 'confirm', tone: 'danger' })
    resolveAppDialog(true)
    await expect(result).resolves.toBe(true)
    expect(appDialogRequest.value).toBeNull()
  })

  it('uses the same state for informational dialogs', async () => {
    const result = showAppAlert({ title: 'About', message: 'Version 1', confirmLabel: 'OK' })

    expect(appDialogRequest.value?.kind).toBe('alert')
    resolveAppDialog(true)
    await expect(result).resolves.toBeUndefined()
  })
})
