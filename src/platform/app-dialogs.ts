import { readonly, shallowRef } from 'vue'

export interface AppDialogOptions {
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
  readonly cancelLabel?: string
  readonly tone?: 'default' | 'danger'
}

export interface AppDialogRequest extends AppDialogOptions {
  readonly id: number
  readonly kind: 'alert' | 'confirm'
}

const request = shallowRef<AppDialogRequest | null>(null)
let nextId = 1
let resolvePending: ((confirmed: boolean) => void) | null = null

export const appDialogRequest = readonly(request)

function open(kind: AppDialogRequest['kind'], options: AppDialogOptions): Promise<boolean> {
  resolvePending?.(false)
  return new Promise((resolve) => {
    resolvePending = resolve
    request.value = { ...options, id: nextId++, kind }
  })
}

export function showAppAlert(options: AppDialogOptions): Promise<void> {
  return open('alert', options).then(() => undefined)
}

export function showAppConfirm(options: AppDialogOptions): Promise<boolean> {
  return open('confirm', options)
}

export function resolveAppDialog(confirmed: boolean): void {
  const resolve = resolvePending
  request.value = null
  resolvePending = null
  resolve?.(confirmed)
}
