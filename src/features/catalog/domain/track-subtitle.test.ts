import { describe, expect, it } from 'vitest'
import type { Track } from '@/types/music'
import { trackSubtitle } from './track-subtitle'

const track: Track = {
  id: 1,
  name: 'Original',
  durationMs: 1,
  artists: [],
  album: { id: 1, name: 'Album', coverUrl: '' },
  aliases: ['Alias'],
  translatedNames: ['Translation'],
  explicit: false,
  playable: true,
  unavailableReason: null,
}

describe('trackSubtitle', () => {
  it('uses aliases before translations', () => {
    expect(trackSubtitle(track)).toBe('Alias')
  })

  it('falls back to the other group and ignores empty or identical names', () => {
    expect(trackSubtitle({ ...track, aliases: [] })).toBe('Translation')
    expect(trackSubtitle({ ...track, aliases: ['', 'Original'], translatedNames: [] })).toBe('')
  })
})
