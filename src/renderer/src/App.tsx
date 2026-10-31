import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, useLocation, useNavigate } from 'react-router'
import { Toaster, toast } from 'sonner'
import CoderPage from '@/coder'
import ConversationPage from '@/conversation'
import SettingsPage from '@/settings'
import HelpPage from '@/help'
import { OverlayToolbar } from '@/coder/OverlayToolbar'
import { useSettingsStore } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useAppStore } from '@/lib/store/app'
import { getCloneableFields } from '@/lib/utils'
import { applyTheme } from '@/lib/theme'
import { WindowResizeHandles } from '@/components/WindowResizeHandles'
import { MODE_PATHS } from '@/lib/use-mode-page'

export default function App() {
  const [initialized, setInitialized] = useState(false)
  const settingsStore = useSettingsStore()
  const { shortcuts } = useShortcutsStore()
  const theme = useSettingsStore((state) => state.theme)

  // Paint the window before syncing with main, so the first frame already uses
  // the persisted theme; the toolbar window gets the live value pushed to it.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    window.api.getAppSettings().then((settings) => {
      // Main starts with stealth on; a persisted "off" must win over that default.
      const blankFields = Object.keys(settings).filter(
        (key) => key !== 'stealthEnabled' && settings[key] && !settingsStore[key]
      )
      settingsStore.syncSettings(
        blankFields.reduce(
          (acc, key) => {
            acc[key] = settings[key]
            return acc
          },
          {} as Partial<typeof settingsStore>
        )
      )
      setInitialized(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (initialized) {
      window.api.updateAppSettings(getCloneableFields(settingsStore))
    }
  }, [initialized, settingsStore])

  // A region picked from the settings page, the toolbar or the shortcut: main
  // applies it at once, the store persists it. Only the main window is told
  useEffect(() => {
    window.api.onCaptureRegionPicked((region) => {
      useSettingsStore.getState().updateSetting('captureRegion', region)
      toast('截图区域已更新，之后只截这块区域')
    })
    return () => window.api.removeCaptureRegionPickedListener()
  }, [])

  // A screenshot was refused for want of image input: remember that about the
  // profile, so 截图模式 no longer offers it. Only an unknown flag is overwritten;
  // the platform's own model list is the better witness
  useEffect(() => {
    window.api.onVisionUnsupported((profileId) => {
      const store = useSettingsStore.getState()
      const profile = store.apiProfiles.find((p) => p.id === profileId)
      if (profile && profile.vision === undefined) store.updateProfile(profileId, { vision: false })
    })
    return () => window.api.removeVisionUnsupportedListener()
  }, [])

  // A newer release, as main finds it: at startup and every few hours after
  useEffect(() => {
    const { setUpdate } = useAppStore.getState()
    window.api.getUpdateStatus().then(setUpdate)
    window.api.onUpdateStatus(setUpdate)
    return () => window.api.removeUpdateStatusListener()
  }, [])

  useEffect(() => {
    console.log('App initShortcuts:', shortcuts) // DEBUG: 检查新键
    window.api.initShortcuts(shortcuts)
    window.api.getShortcuts().then((shortcutsStatus) => {
      console.log('Shortcuts registered:', shortcutsStatus) // DEBUG: 主进程状态
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <HashRouter>
        <ToolbarVisibilityController />
        <WindowResizeController />
        <OpenSettingsController />
        <Routes>
          <Route index element={<CoderPage />} />
          <Route path="conversation" element={<ConversationPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="help" element={<HelpPage />} />
          <Route path="toolbar" element={<OverlayToolbar />} />
        </Routes>
      </HashRouter>

      <Toaster />
    </>
  )
}

/** The toolbar window renders its own handles; this covers the main window's routes */
function WindowResizeController() {
  const location = useLocation()
  const resizable = useSettingsStore((state) => state.resizable)

  if (location.pathname === '/toolbar') return null
  return <WindowResizeHandles enabled={resizable} />
}

/** The menu bar icon's 「设置…」: main shows the window, the routes are ours */
function OpenSettingsController() {
  const navigate = useNavigate()

  useEffect(() => {
    window.api.onOpenSettings(() => navigate('/settings'))
    return () => window.api.removeOpenSettingsListener()
  }, [navigate])

  return null
}

function ToolbarVisibilityController() {
  const location = useLocation()
  const showOverlayToolbar = useSettingsStore((state) => state.showOverlayToolbar)

  useEffect(() => {
    // The toolbar window renders this app too, but must not drive its own visibility
    if (location.pathname === '/toolbar') return
    const onModePage = Object.values(MODE_PATHS).includes(location.pathname)
    void window.api.setToolbarVisible(onModePage && showOverlayToolbar)
  }, [location.pathname, showOverlayToolbar])

  return null
}
