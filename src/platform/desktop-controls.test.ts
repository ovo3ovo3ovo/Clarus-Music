import { describe, expect, it, vi } from 'vitest'
import {
  actionForMenuId,
  executeDesktopAction,
  isReservedMacWindowShortcut,
  isSupportedShortcut,
  normalizeShortcut,
  uniqueSupportedShortcuts,
} from './desktop-controls'
import type { Shortcut } from '@/features/settings/domain/settings'

const shortcut = (id: string, globalShortcut: string): Shortcut => ({
  id,
  name: id,
  shortcut: '',
  globalShortcut,
})

function dependencies() {
  return {
    player: {
      volume: 0.95,
      togglePlayback: vi.fn(),
      next: vi.fn().mockResolvedValue(true),
      previous: vi.fn().mockResolvedValue(false),
      setVolume: vi.fn(),
    },
    window: {
      isVisible: vi.fn().mockResolvedValue(true),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    },
    router: {
      push: vi.fn().mockResolvedValue(undefined),
      back: vi.fn(),
      forward: vi.fn(),
    },
  }
}

describe('desktop controls', () => {
  it('normalizes native shortcut spellings', () => {
    expect(normalizeShortcut('Alt+CommandOrControl+ArrowRight')).toBe('alt+super+right')
    expect(normalizeShortcut('Cmd+M')).toBe('super+m')
    expect(normalizeShortcut(' alt + super + right ')).toBe('alt+super+right')
  })

  it('leaves macOS window shortcuts to the native menu', () => {
    expect(isReservedMacWindowShortcut('Command+H')).toBe(true)
    expect(isReservedMacWindowShortcut('Command+W')).toBe(true)
    expect(isReservedMacWindowShortcut('Command+M')).toBe(true)
    expect(isReservedMacWindowShortcut('Alt+Command+M')).toBe(true)
    expect(isReservedMacWindowShortcut('Alt+Command+P')).toBe(false)
  })

  it('maps native menu ids to supported actions', () => {
    expect(actionForMenuId('menu.play')).toBe('play')
    expect(actionForMenuId('menu.minimize')).toBeNull()
    expect(actionForMenuId('touchbar.search')).toBe('search')
    expect(actionForMenuId('touchbar.queue')).toBe('queue')
    expect(actionForMenuId('unknown')).toBeNull()
  })

  it('only keeps supported, non-empty, unique global shortcuts', () => {
    const duplicate = shortcut('next', 'Alt+CommandOrControl+Right')
    const shortcuts = [
      shortcut('play', 'Alt+CommandOrControl+P'),
      duplicate,
      shortcut('next', 'alt+super+arrowright'),
      shortcut('like', 'Alt+CommandOrControl+L'),
      shortcut('previous', ''),
      shortcut('unknown', 'Alt+CommandOrControl+U'),
    ]
    expect(isSupportedShortcut(shortcuts[0]!)).toBe(true)
    expect(isSupportedShortcut(shortcuts[3]!)).toBe(true)
    expect(isSupportedShortcut(shortcuts[5]!)).toBe(false)
    expect(uniqueSupportedShortcuts(shortcuts)).toEqual([shortcuts[0], duplicate, shortcuts[3]])
  })

  it('routes playback and window actions safely', async () => {
    const deps = dependencies()
    await executeDesktopAction('increaseVolume', deps)
    await executeDesktopAction('decreaseVolume', deps)
    await executeDesktopAction('next', deps)
    await executeDesktopAction('minimize', deps)

    expect(deps.player.setVolume).toHaveBeenNthCalledWith(1, 1)
    expect(deps.player.setVolume).toHaveBeenNthCalledWith(2, 0.85)
    expect(deps.player.next).toHaveBeenCalledOnce()
    expect(deps.window.hide).toHaveBeenCalledOnce()
    expect(deps.window.show).not.toHaveBeenCalled()
  })

  it('does not claim unsupported like actions are handled', async () => {
    const deps = dependencies()
    await expect(executeDesktopAction('like', deps)).resolves.toBe(false)
  })

  it('routes Touch Bar navigation, search, and queue actions', async () => {
    const deps = dependencies()

    await executeDesktopAction('back', deps)
    await executeDesktopAction('forward', deps)
    await executeDesktopAction('search', deps)
    await executeDesktopAction('queue', deps)

    expect(deps.router.back).toHaveBeenCalledOnce()
    expect(deps.router.forward).toHaveBeenCalledOnce()
    expect(deps.router.push).toHaveBeenNthCalledWith(1, '/search')
    expect(deps.router.push).toHaveBeenNthCalledWith(2, '/next')
  })
})
