import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArtistMvView from './ArtistMvView.vue'

const gateway = vi.hoisted(() => ({
  header: vi.fn(),
  videoPage: vi.fn(),
}))

vi.mock('./infrastructure/native-artist', () => ({
  NativeArtistGateway: class {
    readonly header = gateway.header
    readonly videoPage = gateway.videoPage
  },
}))

function artist(id: number) {
  return {
    id,
    name: `Artist ${id}`,
    coverUrl: `https://img.test/artist-${id}.jpg`,
  }
}

function video(artistId: number, id: number) {
  return {
    id,
    artistId,
    name: `Video ${id}`,
    coverUrl: `https://img.test/video-${id}.jpg`,
    publishTime: '',
  }
}

async function flushView(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('ArtistMvView', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('clears a superseded load-more state when the artist route changes', async () => {
    gateway.header.mockImplementation(async (artistId: number) => artist(artistId))
    gateway.videoPage.mockImplementation(
      async (artistId: number, offset: number, signal?: AbortSignal) => {
        if (artistId === 20 && offset === 1) {
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Artist changed', 'AbortError')),
              { once: true },
            )
          })
        }
        return {
          items: [video(artistId, artistId * 10 + offset)],
          nextOffset: offset + 1,
          hasMore: true,
        }
      },
    )

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/artist/:id/mv', component: ArtistMvView }],
    })
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: {
        en: {
          artist: {
            loadingVideos: 'Loading',
            retry: 'Retry',
            videoTitle: "{name}'s Music Videos",
            noVideos: 'No videos',
            loadMore: 'Load more',
            loadingMore: 'Loading more',
          },
        },
      },
    })
    await router.push('/artist/20/mv')
    await router.isReady()
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp(ArtistMvView).use(router).use(i18n)
    app.mount(root)
    await flushView()

    const firstButton = root.querySelector<HTMLButtonElement>('.load-more button')
    expect(firstButton?.disabled).toBe(false)
    firstButton?.click()
    await flushView()
    expect(firstButton?.disabled).toBe(true)

    await router.push('/artist/21/mv')
    await flushView()
    const nextButton = root.querySelector<HTMLButtonElement>('.load-more button')
    expect(nextButton?.disabled).toBe(false)
    expect(gateway.videoPage).toHaveBeenCalledWith(21, 0, expect.any(AbortSignal))

    app.unmount()
  })
})
