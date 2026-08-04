import { gradientFromRgba } from '../domain/cover-gradient'

function abortError(reason?: unknown): DOMException {
  return new DOMException(String(reason ?? 'Cover color extraction aborted'), 'AbortError')
}

function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  if (signal.aborted) return Promise.reject(abortError(signal.reason))
  return new Promise((resolve, reject) => {
    const image = new Image()
    const cleanup = () => {
      image.onload = null
      image.onerror = null
      signal.removeEventListener('abort', handleAbort)
    }
    const handleAbort = () => {
      cleanup()
      image.src = ''
      reject(abortError(signal.reason))
    }
    image.onload = () => {
      cleanup()
      resolve(image)
    }
    image.onerror = () => {
      cleanup()
      reject(new Error('Unable to decode the cover art'))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    image.src = url
  })
}

export async function extractCoverGradient(
  coverUrl: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(coverUrl, { cache: 'force-cache', signal })
  if (!response.ok) throw new Error(`Unable to load the cover art (${response.status})`)
  const objectUrl = URL.createObjectURL(await response.blob())
  try {
    const image = await loadImage(objectUrl, signal)
    if (signal.aborted) throw abortError(signal.reason)
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 16
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return gradientFromRgba(context.getImageData(0, 0, canvas.width, canvas.height).data)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
