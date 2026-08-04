import type { Track } from '@/types/music'

export function trackSubtitle(track: Track): string {
  for (const candidate of track.aliases) {
    if (candidate.length > 0 && candidate !== track.name) return candidate
  }
  for (const candidate of track.translatedNames) {
    if (candidate.length > 0 && candidate !== track.name) return candidate
  }
  return ''
}
