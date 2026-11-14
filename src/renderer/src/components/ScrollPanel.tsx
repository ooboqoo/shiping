import type { ReactNode, Ref, UIEventHandler } from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { ScrollBar } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** How long the scrollbar stays after the last scroll, in ms */
const HIDE_DELAY = 800

/**
 * A page panel that scrolls with an overlay scrollbar: it shows while the
 * panel scrolls and fades out once scrolling stops, taking no width from the
 * content. Built from the primitives rather than ui/scroll-area's ScrollArea,
 * which neither hands out its viewport (paging and auto-scroll need it) nor
 * lets the content be styled.
 *
 * The root needs a definite height (a flex item, or a set height); padding and
 * layout of the scrolled content go in `contentClassName`. The content element
 * is as tall as what it holds, so `h-full` inside it comes to nothing: size to
 * the visible height with `cqh` instead (minus the content's padding).
 *
 * Nothing scrolls sideways: Radix hides horizontal overflow, so anything wider
 * than the panel scrolls in a box of its own (code blocks, formulas, tables).
 */
export function ScrollPanel({
  id,
  className,
  contentClassName,
  scrollbarClassName,
  viewportRef,
  onScroll,
  children
}: {
  id?: string
  className?: string
  contentClassName?: string
  /**
   * E.g. a shorter track (`h-[calc(100%-…)]`), to end it above something
   * floating over the panel's bottom. A margin does nothing: the track's height is set
   */
  scrollbarClassName?: string
  viewportRef?: Ref<HTMLDivElement>
  onScroll?: UIEventHandler<HTMLDivElement>
  children: ReactNode
}) {
  return (
    <ScrollAreaPrimitive.Root
      id={id}
      type="scroll"
      scrollHideDelay={HIDE_DELAY}
      className={cn('relative overflow-hidden', className)}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        onScroll={onScroll}
        // Its own content element instead of Radix's implicit one, which is
        // `display: table`: that lets a long code line widen the whole page
        // instead of scrolling inside its block
        disableImplicitContentElement
        // `container-type: size` lets content size itself to the visible height (cqh)
        className="size-full rounded-[inherit] outline-none [container-type:size]"
      >
        <ScrollAreaPrimitive.Content className={contentClassName} style={{ display: 'block' }}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar
        className={cn(
          'z-10 data-[state=hidden]:animate-out data-[state=hidden]:fade-out-0 data-[state=visible]:animate-in data-[state=visible]:fade-in-0 [&>[data-slot=scroll-area-thumb]]:bg-[var(--app-scrollbar-thumb)]',
          scrollbarClassName
        )}
      />
    </ScrollAreaPrimitive.Root>
  )
}
