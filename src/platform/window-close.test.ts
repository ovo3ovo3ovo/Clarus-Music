import { describe, expect, it, vi } from 'vitest'
import { executeWindowCloseAction, resolveWindowCloseAction } from './window-close'

describe('window close behavior', () => {
  it('always exits when explicitly configured', () => {
    expect(
      resolveWindowCloseAction(
        'exit',
        vi.fn(() => false),
      ),
    ).toBe('exit')
  })

  it('asks only for the ask option and hides when declined', () => {
    const confirmExit = vi.fn(() => false)
    expect(resolveWindowCloseAction('ask', confirmExit)).toBe('hide')
    expect(confirmExit).toHaveBeenCalledOnce()
    expect(resolveWindowCloseAction('minimizeToTray', confirmExit)).toBe('hide')
    expect(confirmExit).toHaveBeenCalledOnce()
  })

  it('prevents the native close before hiding the window', async () => {
    const event = { preventDefault: vi.fn() }
    const flush = vi.fn(async () => undefined)
    const hide = vi.fn(async () => undefined)
    const exit = vi.fn(async () => undefined)

    await executeWindowCloseAction(event, 'hide', flush, hide, exit)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(hide).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
  })

  it('prevents the native close and explicitly exits after flushing settings', async () => {
    const event = { preventDefault: vi.fn() }
    const flush = vi.fn(async () => undefined)
    const hide = vi.fn(async () => undefined)
    const exit = vi.fn(async () => undefined)

    await executeWindowCloseAction(event, 'exit', flush, hide, exit)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(hide).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledOnce()
  })

  it('does not block close actions when settings persistence fails', async () => {
    const event = { preventDefault: vi.fn() }
    const flush = vi.fn(async () => {
      throw new Error('settings unavailable')
    })
    const hide = vi.fn(async () => undefined)
    const exit = vi.fn(async () => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await executeWindowCloseAction(event, 'hide', flush, hide, exit)

    expect(hide).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
