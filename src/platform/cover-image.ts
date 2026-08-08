/**
 * Artwork is one of the few resources for which a small URL can represent a
 * large amount of renderer memory.  Keep the requested pixel dimensions tied
 * to the place where the artwork is displayed instead of treating every cover
 * as a detail image.
 */
export type CoverImageRole =
  'row' | 'avatar' | 'player' | 'card' | 'hero' | 'immersive' | 'media-session' | 'video'

export interface CoverImageOptions {
  readonly exact?: boolean
  /**
   * Permit the final, un-sized source URL as a recovery attempt.  Remote
   * artwork URLs are deliberately bounded by default: an origin URL can be a
   * multi-megapixel master and decoding it in WKWebView is an easy way to
   * turn a navigation sequence into GPU memory growth.
   */
  readonly allowOriginalFallback?: boolean
  readonly maxWidth?: number
  readonly minWidth?: number
  readonly pixelRatio?: number
  readonly role?: CoverImageRole
}

export interface CoverPreloadOptions {
  readonly width?: number
  readonly height?: number
  readonly role?: CoverImageRole
}

interface CoverImagePolicy {
  readonly minWidth: number
  readonly maxWidth: number
}

interface CoverImageRequest {
  readonly url: string
  readonly width: number
  readonly height: number
}

interface PreloadRequest extends CoverImageRequest {
  readonly decodedBytes: number
}

/**
 * These are physical-pixel bounds.  They deliberately describe the visual
 * role, not an API endpoint: callers still pass their rendered CSS size and
 * the request is scaled for the current display density below.
 */
export const COVER_IMAGE_POLICIES: Readonly<Record<CoverImageRole, CoverImagePolicy>> = {
  row: { minWidth: 96, maxWidth: 160 },
  avatar: { minWidth: 96, maxWidth: 160 },
  player: { minWidth: 128, maxWidth: 160 },
  card: { minWidth: 128, maxWidth: 512 },
  hero: { minWidth: 256, maxWidth: 768 },
  // The lyric cover is rendered at roughly 580 CSS px.  1024 physical px is
  // sufficient on a 2x display while avoiding a 1600px decoded backing store
  // for every track transition.
  immersive: { minWidth: 512, maxWidth: 1024 },
  'media-session': { minWidth: 256, maxWidth: 512 },
  video: { minWidth: 320, maxWidth: 960 },
}

// A compact set keeps CDN cache keys reusable without forcing a 512px decode
// for a 36–48px list thumbnail.
const SQUARE_WIDTHS = [96, 128, 160, 256, 384, 512, 768, 1024, 1280, 1600] as const
const LANDSCAPE_WIDTHS = [160, 240, 320, 480, 640, 960, 1280, 1600, 1920] as const
const MAX_ACTIVE_PRELOADS = 1
const MAX_PENDING_PRELOADS = 2
const MAX_REMEMBERED_PRELOADS = 16
const MAX_REMEMBERED_PRELOAD_BYTES = 2 * 1024 * 1024
const PRELOAD_TIMEOUT_MS = 8_000
const EMPTY_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

const prefetchedUrls = new Map<string, PreloadRequest>()
const activePreloads = new Map<HTMLImageElement, PreloadRequest>()
const pendingPreloads: PreloadRequest[] = []
let rememberedPreloadBytes = 0

function normalizedPixelRatio(value?: number): number {
  if (value !== undefined && Number.isFinite(value)) return Math.min(2, Math.max(1, value))
  const deviceRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
  return Math.min(2, Math.max(1, Number.isFinite(deviceRatio) ? deviceRatio : 1))
}

function selectedWidth(target: number, widths: readonly number[]): number {
  return widths.find((width) => width >= target) ?? widths[widths.length - 1] ?? target
}

function normalizedSource(source: string): string {
  const normalizedProtocol = source.trim().replace(/^http:\/\//i, 'https://')
  if (normalizedProtocol.length === 0) return ''

  try {
    const url = new URL(normalizedProtocol)
    url.searchParams.delete('param')
    return url.toString()
  } catch {
    const [withoutHash, hash = ''] = normalizedProtocol.split('#', 2)
    const [path, query = ''] = (withoutHash ?? '').split('?', 2)
    const params = new URLSearchParams(query)
    params.delete('param')
    const normalizedQuery = params.toString()
    return `${path ?? ''}${normalizedQuery ? `?${normalizedQuery}` : ''}${hash ? `#${hash}` : ''}`
  }
}

function sourceVariants(source: string): readonly string[] {
  const normalized = normalizedSource(source)
  if (normalized.length === 0) return []

  const variants = [normalized]
  try {
    const url = new URL(normalized)
    const hostMatch = url.hostname.match(/^p([1-4])\.music\.126\.net$/i)
    if (hostMatch) {
      for (const host of [
        'p1.music.126.net',
        'p2.music.126.net',
        'p3.music.126.net',
        'p4.music.126.net',
      ]) {
        if (host === url.hostname.toLowerCase()) continue
        const variant = new URL(url)
        variant.hostname = host
        variants.push(variant.toString())
      }
    }
  } catch {
    // Non-URL sources still get the normalized and original candidates below.
  }

  const original = source.trim()
  if (original.length > 0 && original !== normalized) variants.push(original)
  return variants
}

function coverPolicy(options: CoverImageOptions): CoverImagePolicy | null {
  return options.role ? COVER_IMAGE_POLICIES[options.role] : null
}

function resolveCoverImageRequest(
  source: string,
  logicalWidth: number,
  logicalHeight: number,
  options: CoverImageOptions,
): CoverImageRequest | null {
  const normalized = normalizedSource(source)
  if (normalized.length === 0) return null

  const width = Math.max(1, logicalWidth)
  const height = Math.max(1, logicalHeight)
  const policy = coverPolicy(options)
  const ratio = normalizedPixelRatio(options.pixelRatio)
  const square = width === height
  const defaultMaximum = square ? 1600 : 1920
  const minimum = Math.max(1, options.minWidth ?? policy?.minWidth ?? 1)
  const maximum = Math.max(minimum, options.maxWidth ?? policy?.maxWidth ?? defaultMaximum)
  const desiredWidth = Math.min(maximum, Math.max(minimum, Math.ceil(width * ratio)))
  const outputWidth = options.exact
    ? desiredWidth
    : Math.min(maximum, selectedWidth(desiredWidth, square ? SQUARE_WIDTHS : LANDSCAPE_WIDTHS))
  const outputHeight = square
    ? outputWidth
    : Math.max(1, Math.round(outputWidth * (height / width)))

  try {
    const url = new URL(normalized)
    url.searchParams.set('param', `${outputWidth}y${outputHeight}`)
    return { url: url.toString(), width: outputWidth, height: outputHeight }
  } catch {
    const separator = normalized.includes('?') ? '&' : '?'
    return {
      url: `${normalized}${separator}param=${outputWidth}y${outputHeight}`,
      width: outputWidth,
      height: outputHeight,
    }
  }
}

export function coverImageUrl(
  source: string,
  logicalWidth: number,
  logicalHeight = logicalWidth,
  options: CoverImageOptions = {},
): string {
  return resolveCoverImageRequest(source, logicalWidth, logicalHeight, options)?.url ?? ''
}

function fallbackWidths(
  request: CoverImageRequest,
  square: boolean,
  minimum: number,
): readonly number[] {
  const widths = square ? SQUARE_WIDTHS : LANDSCAPE_WIDTHS
  // The renderer targets an ES2022 runtime, so avoid Array.prototype.toReversed
  // even though recent Safari supports it.  A copied reverse preserves the
  // immutable bucket tuples above without raising the application's lib target.
  return [...widths].filter((width) => width < request.width && width >= minimum).reverse()
}

/**
 * Returns a short, ordered list of artwork URLs that can recover from a
 * transient CDN error.  Fallbacks never upscale the normal visual request.
 */
export function coverImageCandidates(
  source: string,
  logicalWidth: number,
  logicalHeight = logicalWidth,
  options: CoverImageOptions = {},
): readonly string[] {
  const normalized = normalizedSource(source)
  if (normalized.length === 0) return []

  const initial = resolveCoverImageRequest(source, logicalWidth, logicalHeight, options)
  if (initial === null) return []
  const square = Math.max(1, logicalWidth) === Math.max(1, logicalHeight)
  const minimum = Math.max(1, options.minWidth ?? coverPolicy(options)?.minWidth ?? 1)
  const candidates: string[] = []
  const add = (candidate: string): void => {
    if (candidate.length > 0 && !candidates.includes(candidate)) candidates.push(candidate)
  }

  for (const variant of sourceVariants(source)) {
    add(coverImageUrl(variant, logicalWidth, logicalHeight, options))
  }

  for (const fallbackWidth of fallbackWidths(initial, square, minimum)) {
    add(
      coverImageUrl(
        normalized,
        fallbackWidth,
        square
          ? fallbackWidth
          : Math.max(
              1,
              Math.round(fallbackWidth * (Math.max(1, logicalHeight) / Math.max(1, logicalWidth))),
            ),
        {
          exact: true,
          maxWidth: fallbackWidth,
          minWidth: fallbackWidth,
          pixelRatio: 1,
        },
      ),
    )
  }

  // A bare remote URL may point at the provider's original multi-megapixel
  // master.  Never fall back to it implicitly: the caller can opt in for a
  // legacy endpoint that genuinely ignores `param`, but the normal renderer
  // must keep every decoded image inside the role budget above.
  if (options.allowOriginalFallback) {
    add(normalized)
    const original = source.trim()
    if (original.length > 0 && original !== normalized) add(original)
  }
  return candidates
}

/**
 * Speculative artwork is intentionally tiny and bounded.  It helps a player
 * hand-off without filling WebKit's decoded-image cache with every track the
 * user has visited.
 */
export function preloadCoverImages(source: string, options: CoverPreloadOptions = {}): void {
  if (typeof Image === 'undefined' || source.length === 0) return

  const width = options.width ?? 160
  const height = options.height ?? width
  const request = resolveCoverImageRequest(source, width, height, {
    role: options.role ?? 'player',
  })
  if (request === null) return

  const preload: PreloadRequest = {
    ...request,
    decodedBytes: request.width * request.height * 4,
  }
  if (
    touchRememberedPreload(preload.url) ||
    pendingPreloads.some(({ url }) => url === preload.url) ||
    pendingPreloads.length >= MAX_PENDING_PRELOADS ||
    !rememberPreload(preload)
  ) {
    return
  }
  pendingPreloads.push(preload)
  pumpCoverPreloads()
}

function touchRememberedPreload(url: string): boolean {
  const existing = prefetchedUrls.get(url)
  if (!existing) return false
  prefetchedUrls.delete(url)
  prefetchedUrls.set(url, existing)
  return true
}

function rememberPreload(request: PreloadRequest): boolean {
  if (prefetchedUrls.has(request.url)) return false

  const activeUrls = new Set([...activePreloads.values()].map(({ url }) => url))
  while (
    prefetchedUrls.size >= MAX_REMEMBERED_PRELOADS ||
    rememberedPreloadBytes + request.decodedBytes > MAX_REMEMBERED_PRELOAD_BYTES
  ) {
    let evicted = false
    for (const [url, candidate] of prefetchedUrls) {
      if (activeUrls.has(url) || pendingPreloads.some((pending) => pending.url === url)) continue
      prefetchedUrls.delete(url)
      rememberedPreloadBytes -= candidate.decodedBytes
      evicted = true
      break
    }
    if (!evicted) return false
  }

  prefetchedUrls.set(request.url, request)
  rememberedPreloadBytes += request.decodedBytes
  return true
}

function pumpCoverPreloads(): void {
  while (activePreloads.size < MAX_ACTIVE_PRELOADS && pendingPreloads.length > 0) {
    const request = pendingPreloads.shift()
    if (!request) continue
    const image = new Image()
    image.decoding = 'async'
    activePreloads.set(image, request)
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null
    const release = () => {
      if (!activePreloads.delete(image)) return
      if (timeout !== null) globalThis.clearTimeout(timeout)
      image.removeEventListener?.('load', release)
      image.removeEventListener?.('error', release)
      // Drop the element's decoded-image reference as soon as the speculative
      // request completes.  HTTP cache reuse is still available to visible UI.
      image.src = EMPTY_IMAGE_SRC
      pumpCoverPreloads()
    }
    image.addEventListener('load', release, { once: true })
    image.addEventListener('error', release, { once: true })
    timeout = globalThis.setTimeout(release, PRELOAD_TIMEOUT_MS)
    image.src = request.url
  }
}
