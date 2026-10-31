import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// main and preload leave `dependencies` to node_modules: `build.externalizeDeps` is on by default
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        // The region picker has its own page, so its windows load none of the app
        input: {
          index: resolve('src/renderer/index.html'),
          picker: resolve('src/renderer/picker.html')
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
