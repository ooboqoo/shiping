const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-source.cjs')

function setup(t) {
  const handlers = new Map()
  const keys = new Set()
  const noop = () => {}
  const state = { inCoderPage: true, inConversationPage: false, inSettingsPage: false }
  let miniVisible = false
  const miniBarSender = {}
  let miniBarMode = 'screenshot'
  let onPageChange = noop
  let viewers = false
  let onViewersChanged = noop
  let picker = async () => null
  const window = {
    position: [100, 100],
    visible: true,
    isDestroyed: () => false,
    isVisible() {
      return this.visible
    },
    isFocused: () => false,
    getPosition() {
      return this.position
    },
    setPosition(x, y) {
      this.position = [x, y]
    },
    setOpacity: noop,
    setIgnoreMouseEvents: noop,
    setAlwaysOnTop: noop,
    moveTop: noop,
    hide() {
      this.visible = false
    },
    showInactive() {
      this.visible = true
    },
    show() {
      this.visible = true
    },
    webContents: { send: noop }
  }
  const previousWindow = global.mainWindow
  global.mainWindow = window
  t.after(() => {
    global.mainWindow = previousWindow
  })
  t.mock.method(global, 'setInterval', () => 1)
  t.mock.method(global, 'clearInterval', noop)
  const api = load('src/main/shortcuts.ts', {
    electron: {
      app: { hide: noop },
      ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
      globalShortcut: {
        register: (key) => {
          keys.add(key)
          return true
        },
        unregister: (key) => keys.delete(key),
        isRegistered: (key) => keys.has(key)
      },
      screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920 } }] }
    },
    './window-privacy': { applyContentProtection: noop },
    './toolbar-window': {
      showToolbar: noop,
      hideToolbar: noop,
      setToolbarWanted: noop,
      reassertToolbarTopMost: noop,
      sendToToolbar: noop,
      setToolbarSuppressed: noop,
      setToolbarWidth: noop
    },
    './mini-bar-window': {
      showMiniBar: () => {
        miniVisible = true
      },
      hideMiniBar: () => {
        miniVisible = false
      },
      isMiniBarVisible: () => miniVisible,
      miniBarModeOf: (sender) => (sender === miniBarSender ? miniBarMode : null),
      moveMiniBar: noop,
      updateMiniBarState: noop
    },
    './take-screenshot': {},
    './region-picker': { pickCaptureRegion: () => picker() },
    './save-screenshot': {},
    './save-code': {},
    './ai': {},
    './stream': {},
    './conversation': {},
    './state': {
      state,
      inModePage: () => state.inCoderPage || state.inConversationPage,
      setPageChangeHandler: (fn) => {
        onPageChange = fn
      }
    },
    './settings': { settings: { dashscopeApiKey: 'fixture' }, onSettingsChanged: noop },
    './transcription': {
      onTranscriptionStart: noop,
      onTranscriptionEnd: noop,
      onTranscriptionError: noop
    },
    './mobile-sync': {
      hasMobileViewers: () => viewers,
      onMobileViewersChanged: (fn) => {
        onViewersChanged = fn
      },
      markMobileDirty: noop,
      registerMobileSource: noop
    }
  })
  const actions = [
    'hideOrShowMainWindow',
    'toggleMiniBar',
    'takeScreenshot',
    'switchMode',
    'moveMainWindowUp',
    'generateHint',
    'toggleTranscription'
  ]
  handlers.get('initShortcuts')(
    null,
    Object.fromEntries(actions.map((action, i) => [action, { key: `Control+F${i + 1}` }]))
  )
  return {
    api,
    state,
    window,
    active: (action) => !!api.registeredShortcut(action),
    // A click on the toolbar, not on the mini bar (`miniBarModeOf` answers null)
    trigger: (action) => handlers.get('triggerAction')({ sender: {} }, action),
    // A click on the mini bar showing `mode`'s buttons
    triggerOnMiniBar: (action, mode) => {
      miniBarMode = mode
      return handlers.get('triggerAction')({ sender: miniBarSender }, action)
    },
    pageChanged: () => onPageChange(),
    record: (enabled) => handlers.get('setShortcutRecording')(null, enabled),
    // A phone opens or closes the page (手机同步)
    setViewers: (watching) => {
      viewers = watching
      onViewersChanged()
    },
    miniVisible: () => miniVisible,
    pick: (fn) => {
      picker = fn
      return handlers.get('pickCaptureRegion')()
    }
  }
}

test('visible mini bar keeps actions without phone viewers and hiding it releases them', (t) => {
  const f = setup(t)
  f.trigger('toggleMiniBar')
  assert.equal(f.api.isMainWindowShown(), false)
  assert.equal(f.miniVisible(), true)
  assert.equal(f.active('takeScreenshot'), true)
  assert.equal(f.active('moveMainWindowUp'), true)
  assert.equal(f.active('switchMode'), false)
  f.api.runShortcutAction('hideOrShowMainWindow')
  assert.equal(f.active('takeScreenshot'), false)
  assert.equal(f.active('moveMainWindowUp'), false)
  // Nothing on screen: only the key that brings the bar back is held
  assert.equal(f.active('toggleMiniBar'), false)
  assert.equal(f.active('hideOrShowMainWindow'), true)
  f.api.runShortcutAction('hideOrShowMainWindow')
  assert.equal(f.active('takeScreenshot'), true)
  assert.equal(f.active('toggleMiniBar'), true)
  f.api.revealMainWindow(f.window)
  assert.equal(f.miniVisible(), false)
  assert.equal(f.api.isMainWindowShown(), true)
  assert.equal(f.active('switchMode'), true)
})

test('with phones watching, a hidden mini bar keeps every key but the window ones', (t) => {
  const f = setup(t)
  f.trigger('toggleMiniBar')
  f.api.runShortcutAction('hideOrShowMainWindow')
  assert.equal(f.miniVisible(), false)
  assert.equal(f.active('takeScreenshot'), false)
  // A phone opens the page: the screenshot keys come back without showing anything
  f.setViewers(true)
  assert.equal(f.miniVisible(), false)
  assert.equal(f.active('takeScreenshot'), true)
  assert.equal(f.active('toggleTranscription'), true)
  assert.equal(f.active('toggleMiniBar'), true)
  assert.equal(f.active('hideOrShowMainWindow'), true)
  // Moving a bar no one sees, or leaving its mode, is not offered
  assert.equal(f.active('moveMainWindowUp'), false)
  assert.equal(f.active('switchMode'), false)
  // The same in 对话模式
  f.state.inCoderPage = false
  f.state.inConversationPage = true
  f.pageChanged()
  assert.equal(f.active('generateHint'), true)
  assert.equal(f.active('takeScreenshot'), false)
  // The phone leaves: back to the keys of an app in the background
  f.setViewers(false)
  assert.equal(f.active('generateHint'), false)
  assert.equal(f.active('toggleMiniBar'), false)
  assert.equal(f.active('hideOrShowMainWindow'), true)
})

test('mini bar keeps conversation actions and respects shortcut recording', (t) => {
  const f = setup(t)
  f.state.inCoderPage = false
  f.state.inConversationPage = true
  f.pageChanged()
  f.trigger('toggleMiniBar')
  assert.equal(f.active('generateHint'), true)
  assert.equal(f.active('toggleTranscription'), true)
  assert.equal(f.active('takeScreenshot'), false)
  f.state.inSettingsPage = true
  f.record(true)
  assert.equal(f.active('toggleMiniBar'), false)
  assert.equal(f.active('generateHint'), false)
  f.record(false)
  assert.equal(f.active('toggleMiniBar'), true)
})

test('cancelled and failed region picks restore the mini bar and its keys', async (t) => {
  const f = setup(t)
  f.trigger('toggleMiniBar')
  const inspectHidden = () => {
    assert.equal(f.miniVisible(), false)
    assert.equal(f.active('takeScreenshot'), false)
  }
  assert.equal(
    await f.pick(async () => {
      inspectHidden()
      return null
    }),
    null
  )
  assert.equal(f.miniVisible(), true)
  assert.equal(f.active('takeScreenshot'), true)
  await assert.rejects(
    f.pick(async () => {
      inspectHidden()
      throw new Error('picker failed')
    }),
    /picker failed/
  )
  assert.equal(f.miniVisible(), true)
  assert.equal(f.active('takeScreenshot'), true)
  assert.equal(f.api.isMainWindowShown(), false)
})

test('mini bar clicks are checked against its own buttons, not the toolbar mode', (t) => {
  const f = setup(t)
  // Main window still on 截图模式's page, the bar showing 对话模式's buttons
  assert.equal(f.triggerOnMiniBar('switchMode', 'conversation'), false)
  assert.equal(f.triggerOnMiniBar('takeScreenshot', 'conversation'), false)
  assert.equal(f.trigger('toggleMiniBar'), true)
  assert.equal(f.miniVisible(), true)
  assert.equal(f.triggerOnMiniBar('toggleMiniBar', 'conversation'), true)
  assert.equal(f.miniVisible(), false)
})
