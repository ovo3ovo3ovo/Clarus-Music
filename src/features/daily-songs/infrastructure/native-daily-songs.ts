import { invoke } from '@tauri-apps/api/core'
import { desktop } from '@/platform/desktop'
import { mapNativeTrack } from '@/features/catalog/infrastructure/native-catalog'
import { cancellableInvoke, isRecord, type InvokeCommand } from '@/platform/native-ipc'
import type { DailySongs } from '../domain/daily-songs'

export function mapNativeDailySongs(value: unknown): DailySongs {
  if (!isRecord(value) || !Array.isArray(value.tracks) || value.tracks.length > 100) {
    throw new Error('Invalid daily songs response')
  }
  const tracks = value.tracks
    .map(mapNativeTrack)
    .filter((track): track is NonNullable<ReturnType<typeof mapNativeTrack>> => track !== null)
  if (value.tracks.length > 0 && tracks.length === 0) {
    throw new Error('The daily songs response contained no valid tracks')
  }
  if (new Set(tracks.map(({ id }) => id)).size !== tracks.length) {
    throw new Error('The daily songs response contained duplicate tracks')
  }
  return { tracks }
}

export interface DailySongsGateway {
  load(signal?: AbortSignal): Promise<DailySongs>
}

export class NativeDailySongsGateway implements DailySongsGateway {
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

  async load(signal?: AbortSignal): Promise<DailySongs> {
    const result = await cancellableInvoke<unknown>({
      invokeCommand: this.invokeCommand,
      createRequestId: this.createRequestId,
      isDesktop: this.isDesktop,
      desktopError: 'Daily recommendations require the desktop app',
      abortMessage: 'Daily songs request aborted',
      command: 'daily_songs',
      signal,
    })
    return mapNativeDailySongs(result)
  }
}
