import { describe, expect, it } from 'vitest'
import { audioFormatForSource } from './howler-audio-engine'

describe('Howler source format selection', () => {
  it.each([
    ['audio/flac', 'flac'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg', 'ogg'],
    ['audio/webm', 'webm'],
    ['audio/mpeg', 'mp3'],
  ])('preserves the media format for managed URLs (%s)', (mimeType, expected) => {
    expect(
      audioFormatForSource({
        kind: 'managed-url',
        url: 'asset://localhost/cache/song',
        mimeType,
        release: () => {},
      }),
    ).toBe(expected)
  })
})
