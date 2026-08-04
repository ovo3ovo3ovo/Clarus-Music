import { invoke } from '@tauri-apps/api/core'
import { desktop } from '@/platform/desktop'
import { cancellableInvoke, isRecord, type InvokeCommand } from '@/platform/native-ipc'

export interface TrackLikeGateway {
  check(trackId: number, signal?: AbortSignal): Promise<boolean>
  setLiked(trackId: number, liked: boolean, signal?: AbortSignal): Promise<boolean>
}

function mapLikeState(value: unknown): boolean {
  if (!isRecord(value) || typeof value.liked !== 'boolean') {
    throw new Error('Invalid song like response')
  }
  return value.liked
}

export class NativeTrackLikeGateway implements TrackLikeGateway {
  private readonly invokeCommand: InvokeCommand
  private readonly createRequestId: () => string
  private readonly isDesktop: boolean

  constructor(
    invokeCommand: InvokeCommand = invoke,
    createRequestId: () => string = () => crypto.randomUUID(),
    isDesktop = desktop.isDesktop,
  ) {
    this.invokeCommand = invokeCommand
    this.createRequestId = createRequestId
    this.isDesktop = isDesktop
  }

  check(trackId: number, signal?: AbortSignal): Promise<boolean> {
    return this.request('check_song_like', { trackId }, signal).then(mapLikeState)
  }

  setLiked(trackId: number, liked: boolean, signal?: AbortSignal): Promise<boolean> {
    return this.request('set_song_like', { trackId, liked }, signal).then(mapLikeState)
  }

  private async request(
    command: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return cancellableInvoke<unknown>({
      invokeCommand: this.invokeCommand,
      createRequestId: this.createRequestId,
      isDesktop: this.isDesktop,
      desktopError: 'Song likes require the desktop app',
      abortMessage: 'Like request aborted',
      command,
      args,
      signal,
    })
  }
}

export const nativeTrackLikeGateway = new NativeTrackLikeGateway()
