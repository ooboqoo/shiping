import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { regionToPixels, type RegionRect } from '../../../shared/capture-region'

type PickerData = NonNullable<Awaited<ReturnType<Window['api']['getRegionPickerData']>>>

interface Point {
  x: number
  y: number
}

/** A press that moves less than this many CSS pixels is a click, not a new selection */
const MIN_DRAG = 8
/** A selection reaching this close to the top moves the bar to the bottom, out of its way */
const BAR_FLIP_TOP = 0.15

const percent = (fraction: number): string => `${fraction * 100}%`

const isDrag = (a: Point, b: Point): boolean =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) >= MIN_DRAG

/**
 * Four plain panels that dim everything around `rect`. Plain rectangles on
 * purpose: a clip-path hole or a huge box-shadow on the selection does not
 * paint over the full-screen image in this window.
 */
function dimAround(rect: RegionRect): CSSProperties[] {
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  return [
    { left: 0, top: 0, width: '100%', height: percent(rect.y) },
    { left: 0, top: percent(bottom), width: '100%', bottom: 0 },
    { left: 0, top: percent(rect.y), width: percent(rect.x), height: percent(rect.height) },
    { left: percent(right), top: percent(rect.y), right: 0, height: percent(rect.height) }
  ]
}

function pointOf(e: PointerEvent): Point {
  return {
    x: Math.min(Math.max(e.clientX, 0), window.innerWidth),
    y: Math.min(Math.max(e.clientY, 0), window.innerHeight)
  }
}

/** The rectangle spanned by two points, as fractions of the window, i.e. of the screen */
function spanRect(a: Point, b: Point): RegionRect {
  return {
    x: Math.min(a.x, b.x) / window.innerWidth,
    y: Math.min(a.y, b.y) / window.innerHeight,
    width: Math.abs(a.x - b.x) / window.innerWidth,
    height: Math.abs(a.y - b.y) / window.innerHeight
  }
}

/** `shift`: held as a one-off drag ended, the other of 「框选后」's two behaviours */
const confirm = (rect: RegionRect, shift = false): void =>
  window.api.finishRegionPicker(rect, shift)
const cancel = (): void => window.api.finishRegionPicker(null)

/** What releasing the drag does, and Shift + release, as 「框选后」 is set */
function snipHint({ append, askFirst }: PickerData): string {
  if (askFirst) {
    return append
      ? '松开鼠标后输入问题再追加；按住 Shift 松开直接追加到当前对话'
      : '松开鼠标后输入问题；按住 Shift 松开直接发给 AI'
  }
  return append
    ? '松开鼠标即追加到当前对话；按住 Shift 松开可先输入问题'
    : '松开鼠标即截图发给 AI；按住 Shift 松开可先输入问题'
}

/**
 * One screen's worth of the capture-region picker (see main/region-picker.ts):
 * a frozen capture of the screen to drag a rectangle on. It starts from the
 * region already saved on this screen, if any. Picking a one-off screenshot,
 * the drag ends the pick, like the system's own area screenshot; Shift held as
 * it ends does the other of 「框选后」's two (send at once / ask a question
 * first), with no extra shortcut to hold.
 */
export default function RegionPicker() {
  const [data, setData] = useState<PickerData | null>(null)
  const [rect, setRect] = useState<RegionRect | null>(null)
  const [dragging, setDragging] = useState(false)
  const origin = useRef<Point | null>(null)
  const oneShot = data?.purpose === 'screenshot'

  useEffect(() => {
    void window.api.getRegionPickerData().then((picked) => {
      if (!picked) return
      setData(picked)
      setRect(picked.region)
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      else if (e.key === 'Enter' && rect) confirm(rect)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [rect])

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = pointOf(e)
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (!start) return
    const point = pointOf(e)
    // Until the press really moves, it is a click and the current selection stays
    if (!dragging && !isDrag(start, point)) return
    setDragging(true)
    setRect(spanRect(start, point))
  }

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    origin.current = null
    setDragging(false)
    if (!oneShot || !start) return
    const point = pointOf(e)
    if (!dragging && !isDrag(start, point)) return
    const picked = spanRect(start, point)
    if (picked.width > 0 && picked.height > 0) confirm(picked, e.shiftKey)
  }

  const handlePointerCancel = () => {
    origin.current = null
    setDragging(false)
  }

  if (!data) return null

  const size = rect && regionToPixels(rect, data)
  const barAtBottom = rect !== null && rect.y < BAR_FLIP_TOP

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none overflow-hidden"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={() => rect && confirm(rect)}
    >
      <img
        src={data.image}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full"
        onLoad={() => window.api.regionPickerReady()}
      />

      {rect ? (
        dimAround(rect).map((style, i) => (
          <div key={i} className="absolute bg-black/50" style={style} />
        ))
      ) : (
        <div className="absolute inset-0 bg-black/50" />
      )}
      {rect && (
        <div
          className="absolute border-2 border-sky-400"
          style={{
            left: percent(rect.x),
            top: percent(rect.y),
            width: percent(rect.width),
            height: percent(rect.height)
          }}
        />
      )}

      {!dragging && (
        <div
          className={cn(
            'absolute left-1/2 flex -translate-x-1/2 cursor-default items-center gap-3 rounded-lg bg-neutral-900/90 px-4 py-2 text-sm text-white shadow-lg',
            barAtBottom ? 'bottom-6' : 'top-6'
          )}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {oneShot ? (
            <>
              <span>{data.append ? '拖动鼠标框选要追加的区域' : '拖动鼠标框选要识别的区域'}</span>
              <span className="text-xs text-neutral-400">{snipHint(data)}，Esc 取消</span>
            </>
          ) : (
            <>
              <span>{size ? `${size.width} × ${size.height}` : '拖动鼠标框选截图区域'}</span>
              <span className="text-xs text-neutral-400">
                {size ? '可重新拖动；Enter 或双击确认，Esc 取消' : 'Esc 取消'}
              </span>
              <button
                className="flex items-center gap-1 rounded-md bg-sky-500 px-3 py-1 hover:bg-sky-400 disabled:opacity-40 disabled:hover:bg-sky-500"
                disabled={!rect}
                onClick={() => rect && confirm(rect)}
              >
                <Check className="h-4 w-4" />
                确定
              </button>
            </>
          )}
          <button
            className="flex items-center gap-1 rounded-md bg-white/10 px-3 py-1 hover:bg-white/20"
            onClick={cancel}
          >
            <X className="h-4 w-4" />
            取消
          </button>
        </div>
      )}
    </div>
  )
}
