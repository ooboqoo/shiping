import { selectedLibrary } from './selection'
import { app, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { libraryPaths } from './paths'
import { ManagedLibrary } from './managed'
import { DesktopLibrary } from './desktop-client'
let instance: { manager: ManagedLibrary; client: DesktopLibrary } | undefined
// Resolve paths only after main has applied its optional userData override.
function runtime() {
  if (instance) return instance
  const paths = libraryPaths(app.getPath('userData'))
  const manager = new ManagedLibrary({
    root: paths.root,
    entry: join(__dirname, 'library-service.cjs'),
    publicDir: app.isPackaged
      ? join(process.resourcesPath, 'library-web')
      : join(__dirname, '../../resources/library-web'),
    legacyDocuments: paths.legacyDocuments,
    ocrDir: app.isPackaged
      ? join(process.resourcesPath, 'ocr')
      : join(__dirname, '../../resources/ocr')
  })
  const client = new DesktopLibrary(paths.discovery, async () => {
    await manager.ready()
  })
  instance = { manager, client }
  return instance
}
export const desktopLibrary: Pick<DesktopLibrary, 'call' | 'upload'> = {
  upload: (path, submission, progress, signal, project) =>
    runtime().client.upload(path, submission, progress, signal, project),
  call: (method, args = [], signal) => runtime().client.call(method, args, signal)
}
export async function startLibraryRuntime() {
  const { manager, client } = runtime()
  await manager.ready()
  const cleanup = await client.register().catch(() => undefined)
  app.once('before-quit', () => {
    void cleanup?.()
  })
}
ipcMain.handle('library:open-manager', async (_event, task?: string) => {
  const url = new URL(await runtime().manager.ready())
  url.searchParams.set('project', selectedLibrary())
  if (task && /^[a-f0-9-]{36}$/.test(task)) {
    url.searchParams.set('task', task)
  }
  await shell.openExternal(url.toString())
})
let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !instance) return
  event.preventDefault()
  quitting = true
  void instance.manager.stop().finally(() => app.quit())
})
