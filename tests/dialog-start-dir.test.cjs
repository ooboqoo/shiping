const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const load = require('./load-source.cjs')

/** settings.ts with app.getPath() answering folders under `home` */
function loadSettings(home) {
  const dialogCalls = []
  const handlers = new Map()
  const electron = {
    app: { getPath: (name) => path.join(home, name) },
    dialog: {
      showOpenDialog: async (options) => {
        dialogCalls.push(options)
        return { canceled: true, filePaths: [] }
      }
    },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }
  }
  const mocks = { electron, './toolbar-window': {}, './window-privacy': {} }
  return { ...load('src/main/settings.ts', mocks), dialogCalls, handlers }
}

function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-start-'))
  return Promise.resolve(run(root)).finally(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
}

test('a file dialog opens at the folder, else its nearest existing parent', () =>
  withTempDir((root) => {
    const { dialogStartDir } = loadSettings(root)
    assert.equal(dialogStartDir(root), root)
    // A folder the user removed since: start where it was
    assert.equal(dialogStartDir(path.join(root, 'gone', 'deeper')), root)
    assert.equal(dialogStartDir(''), undefined)
    assert.equal(dialogStartDir(undefined), undefined)
    assert.equal(dialogStartDir('relative/dir'), undefined)
  }))

test('the folder pickers open at the folder in use, the default one included', () =>
  withTempDir(async (root) => {
    const { settings, dialogCalls, handlers } = loadSettings(root)
    const chosen = path.join(root, 'code')
    fs.mkdirSync(chosen)
    settings.codeSaveDir = chosen
    assert.equal(await handlers.get('selectCodeDir')(), null)
    assert.equal(dialogCalls.at(-1).defaultPath, chosen)

    // Nothing chosen: the default folder, or the part of it that exists
    settings.screenshotDir = ''
    fs.mkdirSync(path.join(root, 'pictures'))
    await handlers.get('selectScreenshotDir')()
    assert.equal(dialogCalls.at(-1).defaultPath, path.join(root, 'pictures'))

    settings.conversationSaveDir = ''
    fs.mkdirSync(path.join(root, 'documents', 'Shiping'), { recursive: true })
    await handlers.get('selectConversationDir')()
    assert.equal(dialogCalls.at(-1).defaultPath, path.join(root, 'documents', 'Shiping'))
  }))
