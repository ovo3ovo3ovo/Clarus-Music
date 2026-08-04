export type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringField(value: UnknownRecord, key: string): string {
  const field = value[key]
  return typeof field === 'string' ? field : ''
}

export function integerField(value: UnknownRecord, key: string, minimum = 0): number | null {
  const field = value[key]
  return typeof field === 'number' && Number.isSafeInteger(field) && field >= minimum ? field : null
}

export function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

interface CancellableInvokeOptions {
  readonly invokeCommand: InvokeCommand
  readonly createRequestId: () => string
  readonly isDesktop: boolean
  readonly desktopError: string
  readonly abortMessage: string
  readonly command: string
  readonly args?: Record<string, unknown>
  readonly signal: AbortSignal | undefined
}

export async function cancellableInvoke<T>({
  invokeCommand,
  createRequestId,
  isDesktop,
  desktopError,
  abortMessage,
  command,
  args = {},
  signal,
}: CancellableInvokeOptions): Promise<T> {
  const abortError = () => new DOMException(String(signal?.reason ?? abortMessage), 'AbortError')

  if (signal?.aborted) throw abortError()
  if (!isDesktop) throw new Error(desktopError)

  const requestId = createRequestId()
  const cancel = () => {
    void invokeCommand<boolean>('cancel_music_request', { requestId }).catch(() => undefined)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const result = await invokeCommand<T>(command, { ...args, requestId })
    if (signal?.aborted) throw abortError()
    return result
  } catch (error) {
    if (signal?.aborted) throw abortError()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
