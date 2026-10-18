import { useWindowDrag, type ResizeDirection } from '@/lib/use-window-drag'

const DIRECTIONS: ResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

export function WindowResizeHandles({ enabled }: { enabled: boolean }) {
  const startResize = useWindowDrag(enabled)

  if (!enabled) return null

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
