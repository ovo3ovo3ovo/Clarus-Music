export interface CoverImageOptions {
  readonly exact?: boolean
  readonly maxWidth?: number
  readonly minWidth?: number
  readonly pixelRatio?: number
}

const SQUARE_WIDTHS = [512, 1024, 1600] as const
const LANDSCAPE_WIDTHS = [960, 1280, 1920] as const
const MAX_ACTIVE_PRELOADS = 4
const MAX_PENDING_PRELOADS = 32
const prefetchedUrls = new Set<string>()
const activePreloads = new Set<HTMLImageElement>()
const pendingPreloads: string[] = []

function normalizedPixelRatio(value?: number): number {
  if (value !== undefined && Number.isFinite(value)) return Math.max(1, value)
  const deviceRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
  return Math.max(2, Number.isFinite(deviceRatio) ? deviceRatio : 1)
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

export function coverImageUrl(
  source: string,
  logicalWidth: number,
  logicalHeight = logicalWidth,
  options: CoverImageOptions = {},
): string {
  const normalized = normalizedSource(source)
  if (normalized.length === 0) return ''

  const width = Math.max(1, logicalWidth)
  const height = Math.max(1, logicalHeight)
  const ratio = normalizedPixelRatio(options.pixelRatio)
  const square = width === height
  const defaultMinimum = square ? 512 : 960
  const defaultMaximum = square ? 1600 : 1920
  const minimum = Math.max(1, options.minWidth ?? defaultMinimum)
  const maximum = Math.max(minimum, options.maxWidth ?? defaultMaximum)
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
    return url.toString()
  } catch {
    const separator = normalized.includes('?') ? '&' : '?'
    return `${normalized}${separator}param=${outputWidth}y${outputHeight}`
  }
}

/**
 * Returns a short, ordered list of artwork URLs that can recover from a
 * transient CDN error or an unsupported high-resolution `param` request.
 * The first candidate is always the normal Retina-sized request so healthy
 * images keep their existing quality and caching behaviour.
 */
export function coverImageCandidates(
  source: string,
  logicalWidth: number,
  logicalHeight = logicalWidth,
  options: CoverImageOptions = {},
): readonly string[] {
  const normalized = normalizedSource(source)
  if (normalized.length === 0) return []

  const targetWidth = Math.max(1, logicalWidth)
  const targetHeight = Math.max(1, logicalHeight)
  const square = targetWidth === targetHeight
  const candidates: string[] = []
  const add = (candidate: string): void => {
    if (candidate.length > 0 && !candidates.includes(candidate)) candidates.push(candidate)
  }

  for (const variant of sourceVariants(source)) {
    add(coverImageUrl(variant, targetWidth, targetHeight, options))
  }

  const fallbackWidths = square ? [1600, 1024, 512, 256, 128] : [1920, 1280, 960, 640, 480, 320]
  for (const fallbackWidth of fallbackWidths) {
    add(
      coverImageUrl(
        normalized,
        fallbackWidth,
        square
          ? fallbackWidth
          : Math.max(1, Math.round(fallbackWidth * (targetHeight / targetWidth))),
        {
          exact: true,
          maxWidth: fallbackWidth,
          minWidth: fallbackWidth,
          pixelRatio: 1,
        },
      ),
    )
  }

  // Some CDN records are valid only without a size parameter.
  add(normalized)
  const original = source.trim()
  if (original.length > 0 && original !== normalized) add(original)
  return candidates
}

export function preloadCoverImages(source: string): void {
  if (typeof Image === 'undefined' || source.length === 0) return

  for (const size of [512, 1024] as const) {
    const url = coverImageUrl(source, size, size, {
      exact: true,
      maxWidth: size,
      minWidth: size,
      pixelRatio: 1,
    })
    if (url.length === 0 || prefetchedUrls.has(url)) continue
    if (prefetchedUrls.size >= 512) prefetchedUrls.clear()
    prefetchedUrls.add(url)
    if (pendingPreloads.length >= MAX_PENDING_PRELOADS) continue
    pendingPreloads.push(url)
  }
  pumpCoverPreloads()
}

function pumpCoverPreloads(): void {
  while (activePreloads.size < MAX_ACTIVE_PRELOADS && pendingPreloads.length > 0) {
    const url = pendingPreloads.shift()
    if (!url) continue
    const image = new Image()
    image.decoding = 'async'
    activePreloads.add(image)
    const release = () => {
      if (!activePreloads.delete(image)) return
      pumpCoverPreloads()
    }
    image.addEventListener('load', release, { once: true })
    image.addEventListener('error', release, { once: true })
    image.src = url
  }
}
