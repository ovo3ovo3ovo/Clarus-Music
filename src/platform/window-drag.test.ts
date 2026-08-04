import { describe, expect, it, vi } from 'vitest'
import { installWindowDrag, isWindowDragTarget } from './window-drag'

describe('window drag surface', () => {
  it('recognizes empty descendants as draggable', () => {
    const surface = document.createElement('div')
    const empty = document.createElement('div')
    surface.append(empty)

    expect(isWindowDragTarget(empty)).toBe(true)
  })

  it('recognizes text-node presses inside an empty area as draggable', () => {
    const surface = document.createElement('div')
    const empty = document.createElement('div')
    empty.append(document.createTextNode('empty surface'))
    surface.append(empty)

    expect(isWindowDragTarget(empty.firstChild)).toBe(true)
  })

  it('keeps interactive descendants out of native dragging', () => {
    const surface = document.createElement('div')
    const button = document.createElement('button')
    const icon = document.createElement('span')
    button.append(icon)
    surface.append(button)

    expect(isWindowDragTarget(icon)).toBe(false)
  })

  it('delegates blank mouse presses to the native window', () => {
    const surface = document.createElement('div')
    const empty = document.createElement('div')
    surface.append(empty)
    const startDragging = vi.fn().mockResolvedValue(undefined)
    const remove = installWindowDrag(surface, { startDragging })

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    empty.dispatchEvent(event)

    expect(startDragging).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(false)
    remove()
  })

  it('leaves button presses untouched', () => {
    const surface = document.createElement('div')
    const button = document.createElement('button')
    surface.append(button)
    const startDragging = vi.fn().mockResolvedValue(undefined)
    installWindowDrag(surface, { startDragging })

    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

    expect(startDragging).not.toHaveBeenCalled()
  })
})
