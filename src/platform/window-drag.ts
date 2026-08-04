/**
 * Elements that own a browser interaction must never start a native window
 * drag. The selector intentionally includes semantic roles as well as the
 * non-semantic list rows used by the music views.
 *
 * This is kept in one place because the app uses a frameless/overlay titlebar:
 * a native drag region otherwise wins the hit test before a button, input, or
 * list row can receive its normal pointer event.
 */
const INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'option',
  'summary',
  'video',
  'label',
  'form',
  '[role]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[draggable="true"]',
  '[data-no-window-drag]',
  '.track-row',
  '.album-card',
  '.playlist-card',
  '.cover-card',
  '.artist-row',
  '.video-card',
  '.release-item',
  '.lyric-line',
  '.app-dialog-layer',
  '.app-dialog',
  '.dialog-layer',
  '.dialog-card',
  '.playlist-picker-backdrop',
  '.playlist-picker',
  '.action-menu',
  '.track-context-menu',
  '.settings-select',
  '.settings-select__menu',
  '.appearance-picker',
  '.settings-toggle',
  '.lyric-menu',
  '.toast',
].join(',')

export interface WindowDragHandle {
  startDragging(): Promise<void>
}

function elementFromTarget(target: EventTarget | null): globalThis.Element | null {
  if (target instanceof globalThis.Element) return target

  // A composed event can expose a text node as its target in WebKit. The
  // previous implementation treated that as a non-draggable target, which
  // made dragging depend on whether the pointer happened to land on text or
  // on the surrounding blank area.
  if (target instanceof globalThis.Node && target.parentElement !== null) {
    return target.parentElement
  }

  return null
}

export function isWindowDragTarget(target: EventTarget | null): boolean {
  const element = elementFromTarget(target)
  return element !== null && element.closest(INTERACTIVE_SELECTOR) === null
}

/**
 * Install the native drag command on a surface and delegate it to all of its
 * empty descendants. Tauri's `data-tauri-drag-region` only applies to the
 * element directly carrying the attribute, so delegation is required for the
 * nested layout used by the app.
 */
export function installWindowDrag(
  surface: globalThis.HTMLElement,
  windowHandle: WindowDragHandle,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  const handleMouseDown = (event: globalThis.MouseEvent): void => {
    if (
      event.button !== 0 ||
      event.defaultPrevented ||
      !isWindowDragTarget(event.target)
    )
      return

    // Do not call preventDefault here. Tauri's startDragging command is the
    // native operation, and WebKit may need the original press to remain
    // cancellable while that command takes over the pointer stream.
    void windowHandle.startDragging().catch(onError)
  }

  // Capture on the app shell so a nested view cannot stop the event before it
  // reaches the drag controller. The native command is intentionally started
  // from mousedown, as required by Tauri on macOS and Windows.
  surface.addEventListener('mousedown', handleMouseDown, {
    capture: true,
    passive: true,
  })
  return () =>
    surface.removeEventListener('mousedown', handleMouseDown, {
      capture: true,
    })
}
