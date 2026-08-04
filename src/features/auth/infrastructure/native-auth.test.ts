import { describe, expect, it, vi } from 'vitest'
import { NativeAuthGateway } from './native-auth'

describe('NativeAuthGateway', () => {
  it('uses an opaque request id and forwards the QR key', async () => {
    const invokeCommand = vi.fn(
      async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        expect(command).toBe('check_qr_login')
        expect(args).toEqual({ key: 'qr-key', requestId: 'request-1' })
        return { status: 'waiting', message: 'waiting' }
      },
    ) as unknown as ConstructorParameters<typeof NativeAuthGateway>[0]
    const gateway = new NativeAuthGateway(invokeCommand, () => 'request-1', true)

    await expect(gateway.checkQrLogin('qr-key')).resolves.toEqual({
      status: 'waiting',
      message: 'waiting',
    })
  })

  it('cancels the native task when the caller aborts', async () => {
    let rejectRequest: ((reason: unknown) => void) | undefined
    const invokeMock = vi.fn((command: string): Promise<unknown> => {
      if (command === 'cancel_music_request') return Promise.resolve(true)
      return new Promise<unknown>((_resolve, reject) => {
        rejectRequest = reject
      })
    })
    const invokeCommand = invokeMock as unknown as ConstructorParameters<
      typeof NativeAuthGateway
    >[0]
    const gateway = new NativeAuthGateway(invokeCommand, () => 'request-2', true)
    const controller = new AbortController()
    const request = gateway.checkQrLogin('qr-key', controller.signal)

    controller.abort('view disposed')
    rejectRequest?.(new Error('cancelled'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(invokeMock).toHaveBeenCalledWith('cancel_music_request', {
      requestId: 'request-2',
    })
  })
})
