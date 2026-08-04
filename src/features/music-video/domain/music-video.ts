import type { MusicVideoCard } from '@/features/catalog/domain/catalog'

export interface MusicVideoSource {
  readonly resolution: 1080 | 720 | 480 | 240
  readonly url: string
  readonly mimeType: 'video/mp4'
  readonly sizeBytes: number
}

export interface MusicVideoDetail {
  readonly id: number
  readonly name: string
  readonly coverUrl: string
  readonly artistId: number
  readonly artistName: string
  readonly playCount: number
  readonly publishTime: string
  readonly durationMs: number
  readonly subscribed: boolean
  readonly sources: readonly MusicVideoSource[]
  readonly similarVideos: readonly MusicVideoCard[]
}

function truncated(value: number, places: number): number {
  const scale = 10 ** places
  return Math.floor(value * scale) / scale
}

export function formatPlayCount(count: number, locale: string): string {
  if (count <= 0) return ''
  if (locale === 'zh-CN' || locale === 'zh-TW') {
    const unit = locale === 'zh-CN' ? '万' : '萬'
    const largeUnit = locale === 'zh-CN' ? '亿' : '億'
    if (count > 100_000_000) return `${truncated(count / 100_000_000, 2)}${largeUnit}`
    if (count > 100_000) return `${truncated(count / 10_000, 1)}${unit}`
    if (count > 10_000) return `${truncated(count / 10_000, 2)}${unit}`
    return String(count)
  }
  if (count > 10_000_000) return `${truncated(count / 1_000_000, 1)}M`
  if (count > 1_000_000) return `${truncated(count / 1_000_000, 2)}M`
  if (count > 1_000) return `${truncated(count / 1_000, 2)}K`
  return String(count)
}
