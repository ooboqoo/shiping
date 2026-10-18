import { useEffect, useState } from 'react'
import { GripVertical, MicOff } from 'lucide-react'
import { MINI_BAR_ACTIONS } from '@/lib/toolbar-actions'
import { useWindowDrag } from '@/lib/use-window-drag'
import { applyTheme } from '@/lib/theme'
import { ToolbarButton } from './OverlayToolbar'

type MiniBarState = Awaited<ReturnType<Window['api']['getMiniBarState']>>

/**
 * Contents of the 极简悬浮条 window (`#/mini-bar`): a drag grip and the buttons
 * of the mode it was folded from, in place of the main window while the answer
 * or the hints are read on a phone. Rendered without App, like the region picker, so it never syncs
 * settings or registers shortcuts. It is as non-activating as the toolbar, so
 * the same rules hold: no `title`, nothing hung off `click` or `pointerdown`.
 */
export function MiniBar() {
  const [hoverDelay, setHoverDelay] = useState(0)
  const [{ mode, listening }, setState] = useState<MiniBarState>({
    mode: 'screenshot',
    listening: false
  })
  const startDrag = useWindowDrag()

  useEffect(() => {
    window.api.getMiniBarState().then(setState)
    window.api.onMiniBarState(setState)
    return () => {
      window.api.removeMiniBarStateListener()
    }
  }, [])

  // Main pushes it the toolbar's settings, its own store being a separate copy
  useEffect(() => {
    window.api.getAppSettings().then((settings) => {
      setHoverDelay(settings.toolbarHoverDelay || 0)
    })
    window.api.onSyncToolbarSettings(({ hoverDelay, theme }) => {
      setHoverDelay(hoverDelay || 0)
      applyTheme(theme)
    })
    return () => {
      window.api.removeSyncToolbarSettingsListener()
    }
  }, [])

  return (
    <div className="overlay-toolbar overlay-toolbar-root">
      {/* Picked up from the first move with the button held: Windows discards
          the press on this window (see ToolbarButton) */}
      <div
        className="mini-bar-grip"
        onPointerDown={(event) => {
          if (event.button === 0) startDrag(event, 'move')
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) startDrag(event, 'move')
        }}
      >
        <GripVertical />
      </div>
      {MINI_BAR_ACTIONS[mode].map(({ action, Icon }) => (
        <ToolbarButton
          key={action}
          action={action}
          // The one state shown: recognition that stopped by itself is silent
          Icon={action === 'toggleTranscription' && !listening ? MicOff : Icon}
          hoverDelay={hoverDelay}
        />
      ))}
    </div>
  )
}
