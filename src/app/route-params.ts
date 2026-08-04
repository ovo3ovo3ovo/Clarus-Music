export function parsePositiveIntegerRouteParam(value: unknown): number | null {
  const text = Array.isArray(value) ? value[0] : value
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) return null
  const id = Number(text)
  return Number.isSafeInteger(id) ? id : null
}
