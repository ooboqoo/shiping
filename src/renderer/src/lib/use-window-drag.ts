import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
/** `move` drags the whole window instead of one edge */
type DragDirection = ResizeDirection | 'move'

/**
 * A cursor-tracked drag of this window: once the returned function is called,
 * main follows the cursor until a pointerup, pointercancel or blur anywhere in
 * the window tells it to stop.
 */
export function useWindowDrag(
  enabled = true
): (event: ReactPointerEvent<HTMLElement>, direction: DragDirection) => void {
  const isResizing = useRef(false)

  const stopResize = useCallback(() => {
    if (!isResizing.current) return
    isResizing.current = false
    window.api.stopWindowResize()
  }, [])

  // The handle itself cannot be trusted to see the pointerup: capture does not
  // work on a macOS panel, and releasing after the
  // window hit its minimum size leaves the cursor off the handle. Main follows
  // the cursor until it is told to stop, so listen as widely as we can.
  useEffect(() => {
    if (!enabled) return
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
      stopResize()
    }
  }, [enabled, stopResize])

  return useCallback((event: ReactPointerEvent<HTMLElement>, direction: DragDirection) => {
    if (isResizing.current) return
    isResizing.current = true
    // Started before capturing: main is what actually resizes, and capture is
    // best-effort — it fails on macOS panels and throws on a stale pointer id
    window.api.startWindowResize(direction)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Without capture the window-level listeners above still end the drag
    }
  }, [])
}
