import type { AlbumCard } from '@/features/catalog/domain/catalog'
import type { Track } from '@/types/music'

export interface AlbumArtist {
  readonly id: number
  readonly name: string
}

export interface AlbumDisc {
  readonly disc: string
  readonly tracks: readonly Track[]
}

export interface AlbumDetail {
  readonly id: number
  readonly name: string
  readonly coverUrl: string
  readonly artist: AlbumArtist
  readonly publishTime: number
  readonly trackCount: number
  readonly durationMs: number
  readonly description: string
  readonly company: string
  readonly albumType: string
  readonly explicit: boolean
  readonly subscribed: boolean
  readonly discs: readonly AlbumDisc[]
  readonly moreAlbums: readonly AlbumCard[]
}

export interface AlbumTitle {
  readonly title: string
  readonly subtitle: string
}

const soundtrackDescriptor =
  /Music from the (?:Original Motion Picture Score|Motion Picture|Miniseries)|The Original Motion Picture Soundtrack|Original (?:MGM Motion Picture Soundtrack|Music From The (?:Motion Picture|Netflix Film)|Score to the Motion Picture|Motion Picture (?:Soundtrack|Score)|Television Soundtrack|Videogame Soundtrack|Soundtrack|Score)|Complete (?:Original Motion Picture Score|Motion Picture Score|Score)|Music From The (?:Disney\+ Original Movie|Motion Picture)|Music From the Motion Picture|Soundtrack from the Motion Picture|(?:La |Bande )Originale du Film|Die Original Filmmusik/

const editionDescriptor = /(?:Bonus Tracks|Complete|Tour) Edition|Deluxe (?:Edition|Version)/

function removeDescriptor(title: string, descriptor: string, position: number): string {
  const leading = title.slice(0, position)
  const trailing = title.slice(position + descriptor.length)

  if (leading.endsWith('(') && trailing.startsWith(')')) {
    return `${leading.slice(0, -1)}${trailing.slice(1)}`.trim()
  }
  if (leading.endsWith('[') && trailing.startsWith(']')) {
    return `${leading.slice(0, -1)}${trailing.slice(1)}`.trim()
  }

  return `${leading.replace(/\s*(?::|-)\s*$/, '')}${trailing}`.trim()
}

function splitDescriptor(title: string, pattern: RegExp): AlbumTitle {
  const match = pattern.exec(title)
  if (match === null || match.index === undefined) return { title, subtitle: '' }
  const subtitle = match[0]
  return {
    title: removeDescriptor(title, subtitle, match.index),
    subtitle,
  }
}

export function splitAlbumTitle(name: string): AlbumTitle {
  const soundtrack = splitDescriptor(name, soundtrackDescriptor)
  const edition = splitDescriptor(soundtrack.title, editionDescriptor)
  return {
    title: edition.title,
    subtitle: [soundtrack.subtitle, edition.subtitle].filter(Boolean).join(' · '),
  }
}

export function formatAlbumType(type: string, trackCount: number): string {
  if (type === 'EP/Single') return trackCount === 1 ? 'Single' : 'EP'
  if (type === '专辑') return 'Album'
  return type || 'Album'
}

export function flattenAlbumTracks(discs: readonly AlbumDisc[]): readonly Track[] {
  return discs.flatMap(({ tracks }) => tracks)
}

export function selectAlbumTrack(
  tracks: readonly Track[],
  selectedTrackId?: number,
): { readonly queue: readonly Track[]; readonly index: number; readonly track: Track } | null {
  const queue = tracks.filter((track) => track.playable)
  const index =
    selectedTrackId === undefined ? 0 : queue.findIndex(({ id }) => id === selectedTrackId)
  const track = queue[index]
  return track === undefined ? null : { queue, index, track }
}
