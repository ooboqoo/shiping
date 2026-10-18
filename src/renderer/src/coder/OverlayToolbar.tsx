import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { shownToolbarActions, type ToolbarActionName } from '@/lib/toolbar-actions'
import type { LucideIcon } from 'lucide-react'
import { applyTheme } from '@/lib/theme'
import { useAppStore } from '@/lib/store/app'
import { useSettingsStore } from '@/lib/store/settings'

/**
 * Toolbar rendered in its own always-on-top window above the main window.
 * Buttons carry no `title`: a native tooltip would be drawn outside the window
 * and would therefore not be covered by the window's content protection.
 *
 * Main sizes the window to the buttons (`toolbarWidth()` in shared/toolbar.ts),
 * from the same list and choice this renders.
 */
export function OverlayToolbar() {
  const [hoverDelay, setHoverDelay] = useState(0)
  // This window's store is a copy loaded from localStorage when it opened, right
  // at first paint; later changes are only seen through main's pushes below
  const [buttons, setButtons] = useState(() => useSettingsStore.getState().toolbarButtons)
  const syncAppState = useAppStore((state) => state.syncAppState)
  const inConversationPage = useAppStore((state) => state.inConversationPage)
  const actions = shownToolbarActions(inConversationPage ? 'conversation' : 'screenshot', buttons)

  // This window's store is its own copy, so the state main pushes has to be
  // relayed here; otherwise the toolbar's own buttons show stale state. The
  // page may have been reported before this window loaded, hence the fetch
  useEffect(() => {
    window.api.getAppState().then((state) => syncAppState(state))
    window.api.onSyncAppState((state) => syncAppState(state))
    return () => {
      window.api.removeSyncAppStateListener()
    }
  }, [syncAppState])

  // This window has its own settings store copy, so main pushes the live value.
  // The theme is left to App.tsx on load — this window shares localStorage with
  // the main window, and main's copy may still hold its startup default here.
  useEffect(() => {
    window.api.getAppSettings().then((settings) => {
      setHoverDelay(settings.toolbarHoverDelay || 0)
    })
    window.api.onSyncToolbarSettings(({ hoverDelay, theme, buttons }) => {
      setHoverDelay(hoverDelay || 0)
      applyTheme(theme)
      setButtons(buttons)
    })
    return () => {
      window.api.removeSyncToolbarSettingsListener()
    }
  }, [])

  return (
    <div className="overlay-toolbar overlay-toolbar-root">
      {actions.map(({ action, Icon }) => (
        <ToolbarButton key={action} action={action} Icon={Icon} hoverDelay={hoverDelay} />
      ))}
    </div>
  )
}

/**
 * Fires on mouse release, and — when a dwell time is configured — on hovering
 * the button for that long, which triggers the action without ever pressing it.
 *
 * The release, not a click: there is no click on Windows. This window is
 * `focusable: false`, so Chromium answers the WM_MOUSEACTIVATE of the press
 * with MA_NOACTIVATEANDEAT ("do not activate, and discard the mouse message"),
 * and Windows drops the button-down before the page ever sees it. The
 * button-up is delivered as usual, so the DOM gets a mouseup with no mousedown
 * ahead of it — and therefore never a click. Moves are untouched, which is why
 * hover dwell has always worked there.
 */
export function ToolbarButton({
  action,
  Icon,
  hoverDelay
}: {
  action: ToolbarActionName
  Icon: LucideIcon
  hoverDelay: number
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isDwelling, setIsDwelling] = useState(false)

  const cancelDwell = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setIsDwelling(false)
  }, [])

  // Drop a pending dwell when the setting changes or the toolbar goes away
  useEffect(() => cancelDwell, [cancelDwell, hoverDelay])

  const handleMouseEnter = () => {
    if (!hoverDelay) return
    setIsDwelling(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      // Stays inert until the cursor leaves and comes back, so parking the
      // mouse on a button cannot fire it over and over
      setIsDwelling(false)
      void window.api.triggerAction(action)
    }, hoverDelay)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={cancelDwell}
      onMouseUp={(event) => {
        if (event.button !== 0) return
        cancelDwell()
        void window.api.triggerAction(action)
      }}
    >
      <Icon />
      {isDwelling && (
        <span className="dwell-progress" style={{ animationDuration: `${hoverDelay}ms` }} />
      )}
    </Button>
  )
}
