export interface AudioCacheStats {
  readonly trackCount: number
  readonly totalBytes: number
  readonly limitBytes: number | null
}

export function formatCacheBytes(bytes: number): string {
  const bounded = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (bounded < 1024) return `${Math.round(bounded)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bounded / 1024
  let unit: (typeof units)[number] = units[0]
  for (const candidate of units.slice(1)) {
    if (value < 1024) break
    value /= 1024
    unit = candidate
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${unit}`
}
