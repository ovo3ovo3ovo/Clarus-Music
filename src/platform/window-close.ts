import type { CloseAppOption } from '@/features/settings/domain/settings'

export type WindowCloseAction = 'exit' | 'hide'

export interface WindowCloseRequestEvent {
  preventDefault(): void
}

export function resolveWindowCloseAction(
  option: CloseAppOption,
  confirmExit: () => boolean = () => true,
): WindowCloseAction {
  if (option === 'exit') return 'exit'
  if (option === 'ask' && confirmExit()) return 'exit'
  return 'hide'
}

/**
 * Completes a close request after the user has chosen an action.
 *
 * The close event is always intercepted. This is important for an asynchronous
 * confirmation dialog: if the event is left open while waiting for the dialog,
 * the native window can be destroyed before the user's choice is handled.
 */
export async function executeWindowCloseAction(
  event: WindowCloseRequestEvent,
  action: WindowCloseAction,
  flush: () => Promise<void>,
  hide: () => Promise<void>,
  exit: () => Promise<void>,
): Promise<void> {
  event.preventDefault()

  try {
    await flush()
  } catch (error) {
    // Settings persistence must not make either close action appear stuck.
    console.error('Failed to flush settings before closing the window', error)
  }

  if (action === 'hide') {
    await hide()
    return
  }

  await exit()
}
