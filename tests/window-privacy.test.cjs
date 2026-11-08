const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const load = require('./load-source.cjs')

class Window extends EventEmitter {
  destroyed = false
  protection = []
  isDestroyed() {
    return this.destroyed
  }
  setContentProtection(enabled) {
    this.protection.push(enabled)
  }
  setTitle(title) {
    this.title = title
  }
  setSkipTaskbar(skip) {
    this.skipTaskbar = skip
  }
  setHiddenInMissionControl(hidden) {
    this.hiddenInMissionControl = hidden
  }
}

test('settings toggle applies to all windows, survives restore, and reaches later pickers', () => {
  const handlers = new Map()
  const mocks = {
    electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } },
    './toolbar-window': {},
    './mini-bar-window': {}
  }
  const cache = new Map()
  const privacy = load('src/main/window-privacy.ts', mocks, cache)
  const { settings } = load('src/main/settings.ts', mocks, cache)
  const main = new Window()
  const toolbar = new Window()
  privacy.registerStealthWindow(main, '识屏 Shiping', true)
  privacy.registerStealthWindow(toolbar, '识屏 · 悬浮工具条')
  assert.equal(settings.stealthEnabled, true)
  assert.equal(main.protection.at(-1), true)
  assert.equal(toolbar.protection.at(-1), true)
  assert.equal(main.title, '')

  const update = (enabled) => handlers.get('updateAppSettings')(null, { stealthEnabled: enabled })
  update(false)
  assert.equal(settings.stealthEnabled, false)
  assert.equal(main.protection.at(-1), false)
  assert.equal(toolbar.protection.at(-1), false)
  assert.equal(main.title, '识屏 Shiping')
  assert.equal(main.skipTaskbar, false)
  if (process.platform === 'darwin') assert.equal(main.hiddenInMissionControl, false)

  // The Windows restore path must not turn protection back on after opting out.
  privacy.applyContentProtection(main, true)
  assert.equal(main.protection.at(-1), false)
  const picker = new Window()
  privacy.registerStealthWindow(picker, '识屏 · 框选区域')
  assert.equal(picker.protection.at(-1), false)
  assert.equal(picker.title, '识屏 · 框选区域')
  let prevented = false
  picker.emit('page-title-updated', { preventDefault: () => (prevented = true) })
  assert.equal(prevented, true)
  assert.equal(picker.title, '识屏 · 框选区域')

  picker.destroyed = true
  picker.emit('closed')
  const pickerCalls = picker.protection.length
  update(true)
  assert.equal(main.protection.at(-1), true)
  assert.equal(toolbar.protection.at(-1), true)
  assert.equal(main.title, '')
  assert.equal(toolbar.title, '')
  assert.equal(main.skipTaskbar, true)
  assert.equal(picker.protection.length, pickerCalls)
})

test('mini bar follows stealth changes before creation and after hiding and showing', (t) => {
  const noop = () => {}
  t.mock.method(global, 'setInterval', () => 1)
  t.mock.method(global, 'clearInterval', noop)
  const created = []
  class MiniWindow extends Window {
    constructor() {
      super()
      created.push(this)
    }
    setMenuBarVisibility = noop
    setOpacity = noop
    setAlwaysOnTop = noop
    setVisibleOnAllWorkspaces = noop
    loadFile = noop
    setBounds(bounds) {
      this.bounds = bounds
    }
    getPosition() {
      return [this.bounds?.x ?? 0, this.bounds?.y ?? 0]
    }
    showInactive() {
      this.visible = true
    }
    isVisible() {
      return this.visible
    }
    hide() {
      this.visible = false
    }
    moveTop = noop
  }
  const mocks = {
    electron: {
      BrowserWindow: MiniWindow,
      ipcMain: { handle: noop },
      screen: {
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
      }
    },
    '@electron-toolkit/utils': { is: { dev: false } }
  }
  const cache = new Map()
  const privacy = load('src/main/window-privacy.ts', mocks, cache)
  const bar = load('src/main/mini-bar-window.ts', mocks, cache)
  privacy.setStealthEnabled(false)
  bar.attachMiniBar(new Window())
  // A renderer of its own: not created until the bar is first shown
  assert.equal(created.length, 0)
  bar.showMiniBar([100, 100])
  const mini = created.at(-1)
  assert.equal(mini.protection.at(-1), false)
  assert.equal(mini.title, '识屏 · 极简悬浮条')
  // Counted as shown at once, so its keys are held; on screen once painted
  assert.equal(bar.isMiniBarVisible(), true)
  assert.equal(!!mini.isVisible(), false)
  mini.emit('ready-to-show')
  assert.equal(mini.isVisible(), true)
  assert.equal(mini.protection.at(-1), false)
  privacy.setStealthEnabled(true)
  assert.equal(mini.protection.at(-1), true)
  assert.equal(mini.title, '')
  bar.hideMiniBar()
  privacy.setStealthEnabled(false)
  bar.showMiniBar()
  assert.equal(created.length, 1)
  assert.equal(mini.isVisible(), true)
  assert.equal(mini.protection.at(-1), false)
  assert.equal(mini.title, '识屏 · 极简悬浮条')
  bar.hideMiniBar()
  assert.equal(bar.isMiniBarVisible(), false)
})

test('a mini bar hidden before its page painted stays hidden', (t) => {
  const noop = () => {}
  t.mock.method(global, 'setInterval', () => 1)
  t.mock.method(global, 'clearInterval', noop)
  const created = []
  class MiniWindow extends Window {
    constructor() {
      super()
      created.push(this)
    }
    setMenuBarVisibility = noop
    setOpacity = noop
    setAlwaysOnTop = noop
    setVisibleOnAllWorkspaces = noop
    loadFile = noop
    setBounds = noop
    getPosition = () => [0, 0]
    showInactive() {
      this.visible = true
    }
    hide() {
      this.visible = false
    }
    moveTop = noop
  }
  const mocks = {
    electron: {
      BrowserWindow: MiniWindow,
      ipcMain: { handle: noop },
      screen: {
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
      }
    },
    '@electron-toolkit/utils': { is: { dev: false } }
  }
  const cache = new Map()
  load('src/main/window-privacy.ts', mocks, cache)
  const bar = load('src/main/mini-bar-window.ts', mocks, cache)
  bar.attachMiniBar(new Window())
  bar.showMiniBar([100, 100])
  bar.hideMiniBar()
  const mini = created.at(-1)
  mini.emit('ready-to-show')
  assert.equal(!!mini.visible, false)
  assert.equal(bar.isMiniBarVisible(), false)
})

test('existing installations default to stealth on and a saved opt-out survives restart', () => {
  const saved = new Map([
    ['interview-coder-settings', JSON.stringify({ version: 8, state: { hideDockIcon: true } })]
  ])
  global.localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key)
  }
  const prompts = Object.fromEntries(
    fs
      .readdirSync(path.join(__dirname, '../src/renderer/src/lib/store/prompts'))
      .map((name) => [`./prompts/${name}?raw`, 'fixture prompt'])
  )
  try {
    const { useSettingsStore: store } = load('src/renderer/src/lib/store/settings.ts', prompts)
    assert.equal(store.getState().stealthEnabled, true)
    store.getState().updateSetting('stealthEnabled', false)
    const { useSettingsStore: restarted } = load('src/renderer/src/lib/store/settings.ts', prompts)
    assert.equal(restarted.getState().stealthEnabled, false)
    assert.equal(restarted.getState().hideDockIcon, true)
  } finally {
    delete global.localStorage
  }
})
