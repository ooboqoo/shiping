import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useSettingsStore } from './lib/store/settings'
import { applyTheme } from './lib/theme'

// Paint before the first render: zustand rehydrates from localStorage
// synchronously, so the persisted theme is available here (no dark flash).
applyTheme(useSettingsStore.getState().theme)

// Open in the mode the app was left in. The main window loads without a hash;
// the toolbar loads its own route and is left alone (the region pickers have
// a page of their own, picker.html)
if (!window.location.hash || window.location.hash === '#/') {
  const { lastMode } = useSettingsStore.getState()
  if (lastMode === 'conversation') window.location.hash = '#/conversation'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
