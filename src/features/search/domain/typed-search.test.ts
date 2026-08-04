import { describe, expect, it } from 'vitest'
import type { SearchResultPage } from '@/features/catalog/domain/catalog'
import type { Track } from '@/types/music'
import { appendSearchPage, parseSearchType, searchTypeRouteSegment } from './typed-search'

function track(id: number): Track {
  return {
    id,
    name: `Track ${id}`,
    durationMs: 180_000,
    artists: [],
    album: { id, name: `Album ${id}`, coverUrl: 'https://img.test/cover.jpg' },
    aliases: [],
    translatedNames: [],
    explicit: false,
    playable: true,
    unavailableReason: null,
  }
}

function trackPage(ids: readonly number[], nextOffset: number, hasMore: boolean): SearchResultPage {
  return {
    searchType: 'tracks',
    items: ids.map(track),
    total: 90,
    nextOffset,
    hasMore,
  }
}

describe('typed search pagination', () => {
  it('normalizes the legacy music video route and rejects unknown types', () => {
    expect(parseSearchType('music-videos')).toBe('musicVideos')
    expect(parseSearchType('musicVideos')).toBe('musicVideos')
    expect(searchTypeRouteSegment('musicVideos')).toBe('music-videos')
    expect(parseSearchType('users')).toBeNull()
    expect(parseSearchType(['tracks'])).toBeNull()
  })

  it('appends unique results while retaining server pagination metadata', () => {
    const merged = appendSearchPage(trackPage([1, 2], 30, true), trackPage([2, 3], 60, true))

    expect(merged.searchType).toBe('tracks')
    expect(merged.items.map(({ id }) => id)).toEqual([1, 2, 3])
    expect(merged.nextOffset).toBe(60)
    expect(merged.hasMore).toBe(true)
  })

  it('replaces results when the search type changes', () => {
    const albums: SearchResultPage = {
      searchType: 'albums',
      items: [],
      total: 0,
      nextOffset: 0,
      hasMore: false,
    }

    expect(appendSearchPage(trackPage([1], 30, true), albums)).toBe(albums)
  })
})
