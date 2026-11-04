import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const DIRECTIONS: ResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

export function WindowResizeHandles({ enabled }: { enabled: boolean }) {
  const isResizing = useRef(false)

  const stopResize = useCallback(() => {
    if (!isResizing.current) return
    isResizing.current = false
    window.api.stopWindowResize()
  }, [])

  // The handle itself cannot be trusted to see the pointerup: capture does not
  // work on a macOS panel, and releasing after the window hit its minimum size
  // leaves the cursor off the handle. Main follows the cursor until it is told
  // to stop, so listen as widely as we can.
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

  if (!enabled) return null

  const startResize = (event: ReactPointerEvent<HTMLDivElement>, direction: ResizeDirection) => {
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
  }

  return DIRECTIONS.map((direction) => (
    <div
      key={direction}
      className={`window-resize-handle window-resize-${direction}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        startResize(event, direction)
      }}
    />
  ))
}
