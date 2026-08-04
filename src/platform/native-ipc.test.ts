import { describe, expect, it, vi } from 'vitest'
import { cancellableInvoke, integerField, isRecord, stringField, validHttpUrl } from './native-ipc'

describe('native IPC helpers', () => {
  it('validates narrow record fields and HTTP URLs', () => {
    const record = { id: 3, name: 'Track' }
    expect(isRecord(record)).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(integerField(record, 'id', 1)).toBe(3)
    expect(integerField({ id: 1.5 }, 'id')).toBeNull()
    expect(stringField(record, 'name')).toBe('Track')
    expect(stringField(record, 'missing')).toBe('')
    expect(validHttpUrl('https://music.test/song')).toBe(true)
    expect(validHttpUrl('file:///tmp/song')).toBe(false)
  })

  it('owns cancellation and removes its abort listener after completion', async () => {
    let finish: ((value: string) => void) | undefined
    const invokeCommand = vi.fn(<T>(command: string): Promise<T> => {
      if (command === 'cancel_music_request') return Promise.resolve(true as T)
      return new Promise((resolve) => {
        finish = resolve as (value: string) => void
      })
    })
    const controller = new AbortController()
    const request = cancellableInvoke<string>({
      invokeCommand: invokeCommand as unknown as Parameters<
        typeof cancellableInvoke
      >[0]['invokeCommand'],
      createRequestId: () => 'request-1',
      isDesktop: true,
      desktopError: 'Desktop required',
      abortMessage: 'Request aborted',
      command: 'load_data',
      args: { id: 1 },
      signal: controller.signal,
    })

    controller.abort('route changed')
    finish?.('ignored')

    await expect(request).rejects.toMatchObject({ name: 'AbortError', message: 'route changed' })
    expect(invokeCommand).toHaveBeenCalledWith('cancel_music_request', {
      requestId: 'request-1',
    })
  })

  it('rejects browser calls before invoking native code', async () => {
    const invokeCommand = vi.fn()
    await expect(
      cancellableInvoke({
        invokeCommand,
        createRequestId: () => 'request-1',
        isDesktop: false,
        desktopError: 'Desktop required',
        abortMessage: 'Request aborted',
        command: 'load_data',
        signal: undefined,
      }),
    ).rejects.toThrow('Desktop required')
    expect(invokeCommand).not.toHaveBeenCalled()
  })
})
