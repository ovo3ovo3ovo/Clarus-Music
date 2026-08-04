export interface TrackContextPosition {
  readonly x: number
  readonly y: number
}

export function trackContextPosition(
  pointerX: number,
  pointerY: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 224,
  menuHeight = 160,
): TrackContextPosition {
  return {
    x: Math.max(8, Math.min(pointerX, viewportWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(pointerY, viewportHeight - menuHeight - 8)),
  }
}
