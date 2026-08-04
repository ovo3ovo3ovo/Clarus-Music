import { invoke } from '@tauri-apps/api/core'
import { desktop } from './desktop'

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export interface ExternalLinkGateway {
  openNeteaseSong(songId: number): Promise<void>
  openNeteaseAlbum(albumId: number): Promise<void>
  openNeteaseArtist(artistId: number): Promise<void>
  openNeteaseMusicVideo(musicVideoId: number): Promise<void>
}

export class NativeExternalLinkGateway implements ExternalLinkGateway {
  private readonly invokeCommand: InvokeCommand
  private readonly isDesktop: boolean

  constructor(invokeCommand: InvokeCommand = invoke, isDesktop = desktop.isDesktop) {
    this.invokeCommand = invokeCommand
    this.isDesktop = isDesktop
  }

  openNeteaseSong(songId: number): Promise<void> {
    return this.openNeteaseResource('open_netease_song', 'songId', songId)
  }

  openNeteaseAlbum(albumId: number): Promise<void> {
    return this.openNeteaseResource('open_netease_album', 'albumId', albumId)
  }

  openNeteaseArtist(artistId: number): Promise<void> {
    return this.openNeteaseResource('open_netease_artist', 'artistId', artistId)
  }

  openNeteaseMusicVideo(musicVideoId: number): Promise<void> {
    return this.openNeteaseResource('open_netease_music_video', 'musicVideoId', musicVideoId)
  }

  private openNeteaseResource(command: string, argument: string, id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return Promise.reject(new RangeError(`${argument} must be a positive safe integer`))
    }
    if (!this.isDesktop) {
      return Promise.reject(new Error('Opening NetEase links requires the desktop app'))
    }
    return this.invokeCommand<void>(command, { [argument]: id })
  }
}

export const externalLinkGateway = new NativeExternalLinkGateway()
