/**
 * A visible-frame approximation, not a compositor or human-reading measurement.
 * Wait across a paint opportunity and check the clipping panel as well as the
 * viewport. Offscreen cards can acknowledge later when scrolled into view.
 */
export function observeHintVisible(
  element: HTMLElement,
  onVisible: () => boolean | Promise<boolean>
): () => void {
  let frame: number | null = null
  let reported = false
  let disposed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const inView = () => {
    if (!element.isConnected || document.visibilityState !== 'visible') return false
    const box = element.getBoundingClientRect()
    const panel = element.closest('.panel-scroll')?.getBoundingClientRect()
    return (
      Math.min(box.bottom, panel?.bottom ?? window.innerHeight, window.innerHeight) >
        Math.max(box.top, panel?.top ?? 0, 0) &&
      Math.min(box.right, panel?.right ?? window.innerWidth, window.innerWidth) >
        Math.max(box.left, panel?.left ?? 0, 0)
    )
  }
  const schedule = () => {
    if (disposed || reported || frame !== null || !inView()) return
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (disposed || reported || !inView()) return
        reported = true
        void Promise.resolve(onVisible()).then((accepted) => {
          if (disposed || accepted !== false) return
          // DOM visibility can stay true during Windows soft-hide. Main rejects
          // that acknowledgement; try again after the window is restored.
          reported = false
          retry = setTimeout(schedule, 250)
        })
      })
    })
  }
  const observer = new IntersectionObserver(schedule)
  observer.observe(element)
  document.addEventListener('visibilitychange', schedule)
  schedule()
  return () => {
    disposed = true
    clearTimeout(retry)
    if (frame !== null) window.cancelAnimationFrame(frame)
    observer.disconnect()
    document.removeEventListener('visibilitychange', schedule)
  }
}
