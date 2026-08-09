import { invoke } from '@tauri-apps/api/core'
import { desktop } from './desktop'

/**
 * Asks the native shell to drop WebKit's in-memory website cache only.
 *
 * This deliberately does not touch page state, persistent storage, cookies,
 * the disk cache, or any image element. A failed best-effort trim must never
 * make navigation fail.
 */
export async function clearWebKitMemoryCache(): Promise<boolean> {
  if (!desktop.isDesktop) return false

  try {
    return (await invoke<boolean>('clear_webkit_memory_cache')) === true
  } catch {
    return false
  }
}
