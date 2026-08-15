/**
 * The performance harness supplies one verified HTTP fixture.  Keep its
 * shape deliberately small so feature gateways cannot accidentally receive
 * the native cache or a production media URL in performance mode.
 */
export type PerformanceAudioMimeType = 'audio/mpeg'

export interface PerformanceAudioFixture {
  readonly url: string
  readonly mimeType: PerformanceAudioMimeType
  readonly sizeBytes: number
}

function parseLoopbackUrl(value: unknown, label: string): URL {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a URL`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a URL`)
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(`${label} must use an explicit 127.0.0.1 HTTP port`)
  }
  return url
}

/** Validate and normalize the origin of a performance fixture URL. */
export function validatedLoopbackOrigin(value: unknown): string {
  return parseLoopbackUrl(value, 'Performance fixture URL').origin
}

/**
 * Build the deterministic authenticated avatar from the same origin as the
 * validated audio fixture.  No public image host is used in performance mode.
 */
export function performanceAvatarUrl(audioUrl: unknown): string {
  return `${validatedLoopbackOrigin(audioUrl)}/clarus-perf/avatar.png`
}

export function validatePerformanceAudioFixture(
  value: PerformanceAudioFixture,
): PerformanceAudioFixture {
  parseLoopbackUrl(value.url, 'Performance audio URL')
  if (value.mimeType !== 'audio/mpeg') {
    throw new Error('Performance audio fixture must be audio/mpeg')
  }
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) {
    throw new Error('Performance audio fixture size must be a positive integer')
  }
  return {
    url: value.url,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
  }
}
