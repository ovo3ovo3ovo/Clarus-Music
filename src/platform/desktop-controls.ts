import { watch, type WatchStopHandle } from 'vue'
import type { Router } from 'vue-router'
import type { AppSettings, Shortcut } from '@/features/settings/domain/settings'
import { desktop } from './desktop'

export type DesktopAction =
  | 'about'
  | 'settings'
  | 'play'
  | 'next'
  | 'previous'
  | 'increaseVolume'
  | 'decreaseVolume'
  | 'minimize'
  | 'like'
  | 'back'
  | 'forward'
  | 'search'
  | 'queue'

export interface DesktopPlayerControls {
  readonly volume: number
  togglePlayback(): Promise<void> | void
  next(): Promise<boolean> | boolean
  previous(): Promise<boolean> | boolean
  setVolume(value: number): void
  toggleLike?(): Promise<boolean> | boolean
}

export interface DesktopWindowControls {
  isVisible(): Promise<boolean>
  show(): Promise<void>
  hide(): Promise<void>
  setFocus(): Promise<void>
}

export interface DesktopSettingsSource {
  readonly settings: AppSettings
}

export interface DesktopControlDependencies {
  readonly player: DesktopPlayerControls
  readonly window: DesktopWindowControls
  readonly router: Pick<Router, 'push' | 'back' | 'forward'>
  readonly showAbout?: () => Promise<void> | void
}

const supportedShortcutActions = new Set<DesktopAction>([
  'play',
  'next',
  'previous',
  'increaseVolume',
  'decreaseVolume',
  'minimize',
  'like',
])

const menuActions: Readonly<Record<string, DesktopAction>> = {
  'menu.about': 'about',
  'menu.settings': 'settings',
  'menu.play': 'play',
  'menu.previous': 'previous',
  'menu.next': 'next',
  'menu.increase-volume': 'increaseVolume',
  'menu.decrease-volume': 'decreaseVolume',
  'touchbar.back': 'back',
  'touchbar.forward': 'forward',
  'touchbar.search': 'search',
  'touchbar.previous': 'previous',
  'touchbar.play': 'play',
  'touchbar.next': 'next',
  'touchbar.like': 'like',
  'touchbar.queue': 'queue',
}

/** Normalizes the native plugin's lower-case representation for comparisons and deduplication. */
export function normalizeShortcut(shortcut: string): string {
  return shortcut
    .trim()
    .toLowerCase()
    .replace(/commandorcontrol|commandorctrl|cmdorcontrol|cmdorctrl/g, 'super')
    .replace(/\bcommand\b|\bcmd\b|\bmeta\b/g, 'super')
    .replace(/arrowleft/g, 'left')
    .replace(/arrowright/g, 'right')
    .replace(/arrowup/g, 'up')
    .replace(/arrowdown/g, 'down')
    .replace(/\s+/g, '')
}

/** macOS reserves these for native app-window menu roles. */
export function isReservedMacWindowShortcut(shortcut: string): boolean {
  return new Set(['super+h', 'super+w', 'super+m', 'alt+super+h', 'alt+super+m']).has(
    normalizeShortcut(shortcut),
  )
}

export function actionForMenuId(id: string): DesktopAction | null {
  return menuActions[id] ?? null
}

export function isSupportedShortcut(shortcut: Shortcut): boolean {
  return (
    supportedShortcutActions.has(shortcut.id as DesktopAction) &&
    shortcut.globalShortcut.trim() !== ''
  )
}

export function uniqueSupportedShortcuts(shortcuts: readonly Shortcut[]): readonly Shortcut[] {
  const seen = new Set<string>()
  return shortcuts.filter((shortcut) => {
    if (!isSupportedShortcut(shortcut)) return false
    const key = normalizeShortcut(shortcut.globalShortcut)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function executeDesktopAction(
  action: DesktopAction,
  dependencies: DesktopControlDependencies,
): Promise<boolean> {
  const { player, window, router } = dependencies
  switch (action) {
    case 'about':
      await dependencies.showAbout?.()
      return dependencies.showAbout !== undefined
    case 'settings':
      await router.push('/settings')
      return true
    case 'play':
      await player.togglePlayback()
      return true
    case 'next':
      return Boolean(await player.next())
    case 'previous':
      return Boolean(await player.previous())
    case 'increaseVolume':
      player.setVolume(Math.min(1, player.volume + 0.1))
      return true
    case 'decreaseVolume':
      player.setVolume(Math.max(0, player.volume - 0.1))
      return true
    case 'minimize':
      if (await window.isVisible()) await window.hide()
      else {
        await window.show()
        await window.setFocus()
      }
      return true
    case 'like':
      return dependencies.player.toggleLike === undefined
        ? false
        : Boolean(await dependencies.player.toggleLike())
    case 'back':
      router.back()
      return true
    case 'forward':
      router.forward()
      return true
    case 'search':
      await router.push('/search')
      return true
    case 'queue':
      await router.push('/next')
      return true
  }
}

export async function installDesktopControls(
  settingsSource: DesktopSettingsSource,
  dependencies: DesktopControlDependencies,
): Promise<() => Promise<void>> {
  if (!desktop.isDesktop) return async () => undefined

  const [{ listen }, { getCurrentWindow }, shortcutApi] = await Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/window'),
    import('@tauri-apps/plugin-global-shortcut'),
  ])
  const currentWindow = getCurrentWindow()
  const controls = { ...dependencies, window: currentWindow }
  const runtime = await desktop.getRuntimeInfo()
  const isMacOS = runtime.operatingSystem === 'macos'
  const unlistenMenu = await listen<string>('application-menu-action', (event) => {
    const action = actionForMenuId(event.payload)
    if (action !== null) void executeDesktopAction(action, controls).catch(reportDesktopError)
  })

  let synchronization: Promise<void> = Promise.resolve()
  const synchronizeShortcuts = (): Promise<void> => {
    const task = synchronization.then(async () => {
      await shortcutApi.unregisterAll()
      if (!settingsSource.settings.enableGlobalShortcut) return
      for (const shortcut of uniqueSupportedShortcuts(settingsSource.settings.shortcuts)) {
        if (isMacOS && isReservedMacWindowShortcut(shortcut.globalShortcut)) continue
        try {
          await shortcutApi.register(shortcut.globalShortcut, (event) => {
            if (event.state === 'Pressed') {
              void executeDesktopAction(shortcut.id as DesktopAction, controls).catch(
                reportDesktopError,
              )
            }
          })
        } catch (error) {
          console.warn(`Could not register global shortcut ${shortcut.globalShortcut}`, error)
        }
      }
    })
    synchronization = task.catch((error: unknown) => {
      reportDesktopError(error)
    })
    return synchronization
  }

  const stopWatching: WatchStopHandle = watch(
    () => settingsSource.settings,
    () => void synchronizeShortcuts(),
    { deep: true },
  )
  await synchronizeShortcuts()

  return async () => {
    stopWatching()
    unlistenMenu()
    await synchronization
    await shortcutApi.unregisterAll()
  }
}

function reportDesktopError(error: unknown): void {
  console.error('Desktop control action failed', error)
}
