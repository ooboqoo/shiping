import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RegionPicker from './region-picker'

// The capture-region picker is a throwaway window per screen, opened on every
// pick: its own page, so it loads none of the app (markdown, KaTeX, the stores)
// and must not run App's settings sync or shortcut registration either
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RegionPicker />
  </StrictMode>
)
