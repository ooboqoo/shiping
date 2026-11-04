import { execFileSync } from 'node:child_process'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// main and preload leave `dependencies` to node_modules: `build.externalizeDeps` is on by default
export default defineConfig({
  main: {
    plugins: [
      {
        name: 'local-document-worker',
        closeBundle() {
          execFileSync(process.execPath, [resolve('scripts/build-documents.cjs')], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
          })
        }
      }
    ]
  },
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
