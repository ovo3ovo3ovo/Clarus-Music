function hslFromRgb(red: number, green: number, blue: number): readonly [number, number, number] {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const maximum = Math.max(r, g, b)
  const minimum = Math.min(r, g, b)
  const delta = maximum - minimum
  const lightness = (maximum + minimum) / 2
  if (delta === 0) return [0, 0, lightness]
  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  const hueBase =
    maximum === r
      ? ((g - b) / delta) % 6
      : maximum === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4
  return [(((hueBase * 60) % 360) + 360) % 360, saturation, lightness]
}

function gradient(hue: number, saturation: number, lightness: number): string {
  const dark = Math.max(lightness - 0.1, 0.12)
  const light = Math.min(lightness + 0.28, 0.78)
  const vivid = Math.max(saturation, 0.24)
  return `linear-gradient(to top left, hsl(${hue.toFixed(1)} ${(vivid * 100).toFixed(1)}% ${(dark * 100).toFixed(1)}%), hsl(${((hue + 330) % 360).toFixed(1)} ${(vivid * 100).toFixed(1)}% ${(light * 100).toFixed(1)}%))`
}

export function fallbackCoverGradient(seed: number): string {
  return gradient(Math.abs(seed * 47) % 360, 0.34, 0.4)
}

export function gradientFromRgba(pixels: Uint8ClampedArray): string | null {
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if ((pixels[index + 3] ?? 0) < 128) continue
    red += pixels[index] ?? 0
    green += pixels[index + 1] ?? 0
    blue += pixels[index + 2] ?? 0
    count += 1
  }
  if (count === 0) return null
  const [hue, saturation, lightness] = hslFromRgb(red / count, green / count, blue / count)
  return gradient(hue, saturation, lightness)
}
