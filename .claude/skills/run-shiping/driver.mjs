// Drives the built shiping (识屏) Electron app through Playwright's _electron.
// Agent tooling, not product code: see SKILL.md next to this file.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, as in .ts files */
//
// Commands go over HTTP so they work without tmux:
//   node .claude/skills/run-shiping/driver.mjs &
//   curl -s 'localhost:47123/launch?a=openrouter'
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '../../..')
const RUN_DIR = process.env.RUN_DIR || path.join(os.tmpdir(), 'run-shiping')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(RUN_DIR, 'shots')
const LOG_FILE = path.join(RUN_DIR, 'app.log')
const PORT = Number(process.env.DRIVER_PORT || 47123)
const SAY_VOICE = process.env.SAY_VOICE || 'Tingting'
fs.mkdirSync(SHOT_DIR, { recursive: true })
const log = fs.createWriteStream(LOG_FILE, { flags: 'a' })

const electronBin =
  process.platform === 'darwin'
    ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(APP_DIR, 'node_modules/electron/dist/electron.exe')

let app = null
let page = null
let userData = null

/**
 * The problem window every capture is pinned to (`problem`): its screen, its
 * bounds, and `rect` / `region`, the part captures may take. Null: no capture
 * command runs, since anything captured would be the user's real desktop
 */
let problem = null

/** Actions that capture the screen and send it: refused unless `checkProblem()` passes */
const CAPTURE_ACTIONS = ['takeScreenshot', 'appendScreenshot']
/** These drag in a picker, which only `snip` aims at the problem; through `action` they'd go nowhere safe */
const SNIP_ACTIONS = ['snipScreenshot', 'snipAppendScreenshot']
/**
 * Largest mean difference (0-255, per channel) between the screen and the
 * problem page, over the whole rect and over any one cell of a 12 x 8 grid.
 * The same pixels measure about 1; any other window in the rect, tens
 */
const CHECK_MEAN = 8
const CHECK_CELL = 24

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Capture the problem's rect locally and compare it with the problem page's
 * own rendering, which is what the rect shows when nothing else is there.
 * Nothing is sent anywhere. Only a passing capture is kept (capture-check.png,
 * the problem alone): a failing one may hold the user's own windows, so it is
 * dropped and only where it differs is reported. Covers the moment it runs;
 * something popping up over the problem between this and the capture is not
 */
async function checkProblem() {
  if (!problem) return { ok: false, why: 'no problem window; run `problem` first' }
  const r = await app.evaluate(
    async ({ desktopCapturer, screen }, { p, cols, rows, meanLimit, cellLimit }) => {
      const win = globalThis.__problemWin
      if (!win || win.isDestroyed() || !win.isVisible()) {
        return { ok: false, why: 'the problem window is gone or hidden' }
      }
      const b = win.getBounds()
      if (JSON.stringify(b) !== JSON.stringify(p.bounds)) {
        return { ok: false, why: `the problem window moved to ${JSON.stringify(b)}` }
      }
      const display = screen.getAllDisplays().find((d) => String(d.id) === p.displayId)
      if (!display || JSON.stringify(display.bounds) !== JSON.stringify(p.display)) {
        return { ok: false, why: `screen ${p.displayId} is gone or changed` }
      }
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.bounds.width * display.scaleFactor),
          height: Math.round(display.bounds.height * display.scaleFactor)
        }
      })
      const source = sources.find((s) => s.display_id === p.displayId)
      if (!source) return { ok: false, why: `no capture source for screen ${p.displayId}` }
      const k = source.thumbnail.getSize().width / display.bounds.width
      const shot = source.thumbnail.crop({
        x: Math.round((p.rect.x - display.bounds.x) * k),
        y: Math.round((p.rect.y - display.bounds.y) * k),
        width: Math.round(p.rect.width * k),
        height: Math.round(p.rect.height * k)
      })
      const own = await win.webContents.capturePage({
        x: p.rect.x - b.x,
        y: p.rect.y - b.y,
        width: p.rect.width,
        height: p.rect.height
      })
      // Small enough to forgive anti-aliasing and color management, cells to catch a corner
      const size = { width: cols * 4, height: rows * 4, quality: 'good' }
      const a = shot.resize(size).toBitmap()
      const c = own.resize(size).toBitmap()
      const cells = new Array(cols * rows).fill(0)
      let total = 0
      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          const i = (y * size.width + x) * 4
          // BGRA; alpha left out
          const diff =
            (Math.abs(a[i] - c[i]) +
              Math.abs(a[i + 1] - c[i + 1]) +
              Math.abs(a[i + 2] - c[i + 2])) /
            3
          total += diff
          cells[Math.floor(y / 4) * cols + Math.floor(x / 4)] += diff / 16
        }
      }
      const mean = total / (size.width * size.height)
      const worst = Math.max(...cells)
      // Rows / columns of the 12 x 8 grid that differ, for a failure's report
      const bad = cells
        .map((v, i) => (v > cellLimit ? `r${Math.floor(i / cols) + 1}c${(i % cols) + 1}` : ''))
        .filter(Boolean)
      const pass = mean <= meanLimit && worst <= cellLimit
      return {
        mean,
        cell: worst,
        bad,
        png: pass ? shot.toPNG().toString('base64') : null
      }
    },
    { p: problem, cols: 12, rows: 8, meanLimit: CHECK_MEAN, cellLimit: CHECK_CELL }
  )
  if (r.ok === false) return r
  const file = path.join(SHOT_DIR, 'capture-check.png')
  // Never leave an old passing image next to a failure, to be mistaken for this one
  fs.rmSync(file, { force: true })
  const measured = `mean ${r.mean.toFixed(1)}, worst cell ${r.cell.toFixed(1)} (limits ${CHECK_MEAN} / ${CHECK_CELL})`
  if (r.png) {
    fs.writeFileSync(file, Buffer.from(r.png, 'base64'))
    return { ok: true, why: `the capture rect shows only the problem; ${measured}` }
  }
  return {
    ok: false,
    why:
      `something other than the problem shows in the capture rect; ${measured}; ` +
      `differing cells of 12 x 8: ${r.bad.join(' ') || '(spread out)'}. ` +
      'The capture was dropped unseen: ask the user to clear the problem window, do not look'
  }
}

/** `.env` lines, commented-out ones included (the template keeps one block per platform) */
function envLines() {
  const file = path.join(APP_DIR, '.env')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : []
}

function envValue(line, name) {
  return line
    .replace(new RegExp(`^#?\\s*${name}=`), '')
    .replace(/\s+#.*$/, '')
    .replace(/^["']|["']$/g, '')
    .trim()
}

/**
 * API settings for the launch. Explicit env vars win; otherwise `block` picks
 * the `.env` API_BASE_URL line containing that word (commented or not) and the
 * API_KEY line after it. Values are never printed.
 */
function apiEnv(block) {
  const env = {}
  if (block) {
    const lines = envLines()
    const i = lines.findIndex((l) => /API_BASE_URL=/.test(l) && l.includes(block))
    if (i < 0) throw new Error(`no API_BASE_URL line containing "${block}" in .env`)
    const keyLine = lines.slice(i + 1).find((l) => /API_KEY=/.test(l))
    env.API_BASE_URL = envValue(lines[i], 'API_BASE_URL')
    if (keyLine) env.API_KEY = envValue(keyLine, 'API_KEY')
  }
  for (const name of ['API_BASE_URL', 'API_KEY', 'MODEL']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

/** Newest mtime under a directory, for the stale-build check */
function newestMtime(dir) {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs)
  }
  return newest
}

function buildWarning() {
  const built = path.join(APP_DIR, 'out/renderer/index.html')
  if (!fs.existsSync(built)) return 'NO BUILD: run `npx electron-vite build` first. '
  return newestMtime(path.join(APP_DIR, 'src')) > fs.statSync(built).mtimeMs
    ? 'WARNING: src/ is newer than out/ - rebuild with `npx electron-vite build`. '
    : ''
}

function need() {
  if (!page) throw new Error('launch first')
}

/** 截图模式: the reasoning blocks and the end of the answer */
const SOLUTION_STATE = () => {
  const root = document.querySelector('#app-content')
  if (!root) return { page: location.hash, noContent: true }
  const blocks = [...root.querySelectorAll('button')]
    .filter((b) => b.textContent.includes('思考过程'))
    .map((b) => {
      const box = b.nextElementSibling
      return {
        label: b.textContent.trim(),
        open: !!box,
        streaming: !!box && box.className.includes('justify-end'),
        height: box ? Math.round(box.getBoundingClientRect().height) : 0,
        tail: box ? box.textContent.slice(-80).replace(/\s+/g, ' ') : null
      }
    })
  return {
    loading: !!document.querySelector('.animate-spin'),
    blocks,
    textLen: root.innerText.length,
    tail: root.innerText.slice(-160).replace(/\s+/g, ' ')
  }
}

/** 对话模式: one entry per hint card */
const HINT_STATE = () =>
  [...document.querySelectorAll('article')].map((card) => ({
    meta: card.firstElementChild?.innerText.replace(/\s+/g, ' '),
    // A streaming card loses its spinner at the first text chunk; only a finished
    // one shows its latency (`自动 · 1.7s`), 已停止 or 生成失败
    busy:
      !!card.querySelector('.animate-spin, .animate-pulse') ||
      !/\d+\.\ds|已停止|生成失败/.test(card.innerText),
    reasoning: card.querySelector('details')?.innerText.replace(/\s+/g, ' ') ?? null,
    text: card.innerText.slice(-160).replace(/\s+/g, ' ')
  }))

const clickText = (t) => {
  const els = [...document.querySelectorAll('button, a, [role="button"], summary')]
  const el =
    els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
  if (!el) return 'NOT_FOUND'
  el.click()
  return 'OK'
}

const PROBLEM_HTML = `<html><body style="margin:0;font:18px/1.55 -apple-system,sans-serif;padding:28px 44px;background:#fff;color:#111">
<h1>1. 两数之和</h1>
<p>给定一个整数数组 <code>nums</code> 和一个整数目标值 <code>target</code>，请你在该数组中找出
<b>和为目标值</b> <code>target</code> 的那 <b>两个</b> 整数，并返回它们的数组下标。</p>
<p>你可以假设每种输入只会对应一个答案，并且你不能使用两次相同的元素。</p>
<h3>示例 1：</h3>
<pre style="background:#f4f4f4;padding:16px">输入：nums = [2,7,11,15], target = 9
输出：[0,1]
解释：因为 nums[0] + nums[1] == 9 ，返回 [0, 1] 。</pre>
<h3>提示：</h3>
<ul><li>2 &lt;= nums.length &lt;= 10^4</li><li>-10^9 &lt;= nums[i] &lt;= 10^9</li><li>只会存在一个有效答案</li></ul>
<p><b>进阶：</b>你可以想出一个时间复杂度小于 O(n^2) 的算法吗？</p>
</body></html>`

const COMMANDS = {
  ping: () => 'pong',

  /** `launch [envBlock]`: start the built app on a fresh userData dir */
  async launch(block) {
    if (app) return 'already launched'
    const warning = buildWarning()
    userData = fs.mkdtempSync(path.join(RUN_DIR, 'userdata-'))
    app = await electron.launch({
      executablePath: electronBin,
      args: [APP_DIR, `--user-data-dir=${userData}`],
      cwd: APP_DIR,
      env: { ...process.env, ...apiEnv(block) },
      timeout: 30_000
    })
    app.process().stdout.on('data', (d) => log.write(d))
    app.process().stderr.on('data', (d) => log.write(d))
    // Two windows: the main one and the overlay toolbar (`index.html#toolbar`)
    const deadline = Date.now() + 20_000
    while (!page && Date.now() < deadline) {
      page = app
        .windows()
        .find((w) => w.url().includes('index.html') && !w.url().includes('toolbar'))
      if (!page) await sleep(300)
    }
    if (!page) throw new Error('main window never appeared; see ' + LOG_FILE)
    await page.waitForSelector('#app-content, article, main', { timeout: 15_000 }).catch(() => {})
    const header = await page.evaluate(
      () => document.querySelector('header, #app-header')?.innerText
    )
    return `${warning}launched. header: ${header?.replace(/\s+/g, ' ')}; userData: ${userData}`
  },

  /** `ss [name]`: screenshot of the main window (content protection does not block it) */
  async ss(name) {
    need()
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png')
    await page.screenshot({ path: f })
    return f
  },

  /** Screens, cursor and the app's windows, in screen coordinates; captures nothing */
  async screens() {
    need()
    return JSON.stringify(
      await app.evaluate(({ BrowserWindow, screen }) => ({
        cursor: screen.getCursorScreenPoint(),
        primary: screen.getPrimaryDisplay().id,
        displays: screen.getAllDisplays().map((d) => ({
          id: d.id,
          bounds: d.bounds,
          scale: d.scaleFactor
        })),
        windows: BrowserWindow.getAllWindows().map((w) => ({
          page: w.webContents.getURL().replace(/^.*\//, '').slice(0, 40),
          bounds: w.getBounds(),
          visible: w.isVisible()
        }))
      })),
      null,
      1
    )
  },

  /**
   * Put a coding problem on screen for screenshots to capture, and pin every
   * capture to it. Never follow the cursor: it is the user's, on whichever
   * screen they are working, and a capture there sends their desktop to the AI.
   * The window goes on the main window's screen, always on top (below the
   * app's own windows, which content protection leaves out of captures), and
   * the app's capture region is set to it, so takeScreenshot crops to it
   * whatever screen the cursor is on. Ends with `check`.
   */
  async problem() {
    need()
    if (problem) await COMMANDS.closeproblem()
    const placed = await app.evaluate(async ({ BrowserWindow, screen }, html) => {
      const main = globalThis.mainWindow
      const display = screen.getDisplayMatching(main.getBounds())
      const area = display.workArea
      const width = Math.min(1000, area.width - 80)
      const height = Math.min(720, area.height - 80)
      const win = new BrowserWindow({
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
        width,
        height,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        // Like the main window: shown over other apps' fullscreen Spaces too
        ...(process.platform === 'darwin' && { type: 'panel' })
      })
      // Above the user's windows, below the main window and toolbar (screen-saver)
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true
      })
      const shown = new Promise((resolve) => win.once('ready-to-show', resolve))
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      await shown
      win.showInactive()
      globalThis.__problemWin = win
      return { displayId: String(display.id), display: display.bounds, bounds: win.getBounds() }
    }, PROBLEM_HTML)
    // Captures stay a few pixels inside the window's edges
    const inset = 6
    const b = placed.bounds
    const rect = {
      x: b.x + inset,
      y: b.y + inset,
      width: b.width - 2 * inset,
      height: b.height - 2 * inset
    }
    const d = placed.display
    const region = {
      displayId: placed.displayId,
      x: (rect.x - d.x) / d.width,
      y: (rect.y - d.y) / d.height,
      width: rect.width / d.width,
      height: rect.height / d.height
    }
    problem = { ...placed, rect, region }
    // The way a pick reaches the store: the renderer persists it and syncs it to main
    await app.evaluate(
      (_electron, r) => globalThis.mainWindow.webContents.send('capture-region-picked', r),
      region
    )
    const deadline = Date.now() + 5_000
    let synced = false
    while (!synced && Date.now() < deadline) {
      const current = await page.evaluate(() =>
        window.api.getAppSettings().then((s) => s.captureRegion)
      )
      synced = JSON.stringify(current) === JSON.stringify(region)
      if (!synced) await sleep(200)
    }
    if (!synced) {
      await COMMANDS.closeproblem()
      return 'ERROR: the capture region never reached main; problem window closed'
    }
    return `problem window on display ${placed.displayId} at ${JSON.stringify(b)}; captures pinned to it\n${await COMMANDS.check()}`
  },

  /**
   * Whether a capture right now would see the problem window and nothing else:
   * the screen inside the capture rect, captured locally (never sent), against
   * the problem page's own rendering. Anything else showing there (a window
   * over it, another Space, a moved window) fails it. Every capture command
   * runs it first and refuses on failure. A passing capture -> capture-check.png
   */
  async check() {
    need()
    const r = await checkProblem()
    return `${r.ok ? 'CHECK OK' : 'CHECK FAILED'}: ${r.why}`
  },

  /**
   * `cover [on|off]`: an opaque window over one corner of the problem, standing in
   * for any window that turns up in front of it. `check` must fail while it is up;
   * the way to prove the guard still works after changing it
   */
  async cover(arg) {
    need()
    if (!problem) return 'no problem window; run `problem` first'
    return app.evaluate(
      async ({ BrowserWindow }, { on, rect }) => {
        globalThis.__coverWin?.destroy()
        globalThis.__coverWin = null
        if (!on) return 'cover removed'
        const win = new BrowserWindow({
          x: rect.x + Math.round(rect.width * 0.6),
          y: rect.y + Math.round(rect.height * 0.6),
          width: Math.round(rect.width * 0.3),
          height: Math.round(rect.height * 0.3),
          show: false,
          frame: false,
          focusable: false,
          skipTaskbar: true,
          backgroundColor: '#d03030'
        })
        win.setAlwaysOnTop(true, 'pop-up-menu')
        await win.loadURL('data:text/html,<body style="margin:0;background:%23d03030">')
        win.showInactive()
        globalThis.__coverWin = win
        return `cover up at ${JSON.stringify(win.getBounds())}`
      },
      { on: arg !== 'off', rect: problem.rect }
    )
  },

  async closeproblem() {
    need()
    problem = null
    return app.evaluate(() => {
      globalThis.__problemWin?.destroy()
      globalThis.__problemWin = null
      return 'closed; captures are refused until the next `problem`'
    })
  },

  /** `action <name>`: a shortcut action, e.g. takeScreenshot / appendScreenshot / stopSolutionStream */
  async action(name) {
    need()
    if (SNIP_ACTIONS.includes(name))
      return `refused ${name}: use \`snip\`, which drags inside the problem`
    if (CAPTURE_ACTIONS.includes(name)) {
      const r = await checkProblem()
      if (!r.ok) return `refused ${name}, nothing captured: ${r.why}`
    }
    const ok = await page.evaluate((n) => window.api.triggerAction(n), name)
    return ok
      ? `triggered ${name}`
      : `refused ${name} (not a toolbar button of the mode on screen, TOOLBAR_LAYOUT in src/shared/toolbar.ts)`
  },

  /**
   * `snip [append] [shift]`: 框选识别 (`append`: 框选追加截图), dragging inside the problem
   * window on its own screen's picker (one opens per screen; any other drags the
   * user's desktop), with Shift held on release if asked. Global shortcuts can't
   * be pressed, so it goes through triggerAction; refused unless `check` passes
   */
  async snip(arg) {
    need()
    const action = arg.includes('append') ? 'snipAppendScreenshot' : 'snipScreenshot'
    const shift = arg.includes('shift')
    const r = await checkProblem()
    if (!r.ok) return `refused ${action}, nothing captured: ${r.why}`
    const before = new Set(app.windows())
    if (!(await page.evaluate((n) => window.api.triggerAction(n), action))) {
      return `refused ${action}`
    }
    // The picker of the problem's screen: it covers that screen, so it sits at its origin
    const d = problem.display
    let picker = null
    const deadline = Date.now() + 15_000
    while (!picker && Date.now() < deadline) {
      for (const w of app.windows()) {
        if (before.has(w) || !w.url().includes('picker.html')) continue
        const at = await w.evaluate(() => [screenX, screenY]).catch(() => null)
        if (at && at[0] === d.x && at[1] === d.y) picker = w
      }
      if (!picker) await sleep(200)
    }
    if (!picker) {
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (w.webContents.getURL().includes('picker.html')) w.close()
        }
      })
      return `no picker on the problem's screen (${problem.displayId}); pick cancelled, nothing captured`
    }
    await picker.waitForFunction(() => document.querySelector('img')?.complete, null, {
      timeout: 10_000
    })
    const hint = await picker.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())
    // From 15% to 85% of the problem window, in the picker's own coordinates
    const { rect } = problem
    const at = (fx, fy) => [rect.x - d.x + rect.width * fx, rect.y - d.y + rect.height * fy]
    await picker.mouse.move(...at(0.15, 0.15))
    await picker.mouse.down()
    await picker.mouse.move(...at(0.5, 0.5), { steps: 5 })
    if (shift) await picker.keyboard.down('Shift')
    await picker.mouse.move(...at(0.85, 0.85), { steps: 5 })
    // The picker closes on release, so nothing after it may wait on that window
    await picker.mouse.up().catch(() => {})
    if (shift) await picker.keyboard.up('Shift').catch(() => {})
    return `dragged in ${action} on display ${problem.displayId}${shift ? ' with Shift held' : ''}; picker said: ${hint}`
  },

  /** The main window as main sees it: shown, focused, bounds (soft-hide parks it off-screen) */
  async winstate() {
    need()
    return JSON.stringify(
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find(
          (b) =>
            b.webContents.getURL().includes('index.html') &&
            !b.webContents.getURL().includes('toolbar')
        )
        return w && { visible: w.isVisible(), focused: w.isFocused(), ...w.getBounds() }
      })
    )
  },

  /** `toolbar [name]`: the overlay toolbar window's bounds and buttons, screenshot -> `<name>.png` */
  async toolbar(name) {
    need()
    const bar = app.windows().find((w) => w.url().includes('toolbar'))
    if (!bar) return 'no toolbar window (悬浮工具条 off, or not created yet)'
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((b) =>
        b.webContents.getURL().includes('toolbar')
      )
      return w && { ...w.getBounds(), visible: w.isVisible() }
    })
    const buttons = await bar.evaluate(
      () => document.querySelectorAll('.overlay-toolbar-root button').length
    )
    const f = path.join(SHOT_DIR, (name || `toolbar-${Date.now()}`) + '.png')
    await bar.screenshot({ path: f })
    return JSON.stringify({ ...bounds, buttons, shot: f })
  },

  /** `followup <question>`: ask within the current 截图模式 conversation */
  async followup(text) {
    need()
    page.evaluate((t) => window.api.sendFollowUpQuestion(t), text).catch(() => {})
    return 'sent'
  },

  async state() {
    need()
    return JSON.stringify(await page.evaluate(SOLUTION_STATE), null, 1)
  },

  /**
   * `watch [seconds]`: follow a 截图模式 answer until it settles - no spinner and
   * no new text for 2.5s. A follow-up shows no spinner, so text growth is what
   * counts. Screenshots every change in the reasoning blocks.
   */
  async watch(seconds) {
    need()
    const t0 = Date.now()
    const until = t0 + Number(seconds || 120) * 1000
    const out = []
    let lastBlocks = ''
    let lastLen = -1
    let stableSince = Date.now()
    while (Date.now() < until) {
      const s = await page.evaluate(SOLUTION_STATE)
      const t = ((Date.now() - t0) / 1000).toFixed(1)
      const blocks = JSON.stringify(s.blocks.map((b) => [b.label, b.open, b.streaming, b.height]))
      if (blocks !== lastBlocks) {
        lastBlocks = blocks
        // A later round's block is below the fold; bring the newest one into the shot
        await page.evaluate(() => {
          const heads = [...document.querySelectorAll('#app-content button')].filter((b) =>
            b.textContent.includes('思考过程')
          )
          heads.at(-1)?.scrollIntoView({ block: 'start' })
        })
        const shot = path.join(SHOT_DIR, `watch-${Date.now()}.png`)
        await page.screenshot({ path: shot })
        out.push(`${t}s textLen=${s.textLen} blocks=${blocks} -> ${shot}`)
      }
      if (s.textLen !== lastLen || s.loading) {
        lastLen = s.textLen
        stableSince = Date.now()
      } else if (Date.now() - stableSince > 2500 && Date.now() - t0 > 4000) {
        out.push(`${t}s settled, textLen=${s.textLen}`)
        return out.join('\n')
      }
      await sleep(250)
    }
    out.push('TIMEOUT - still changing')
    return out.join('\n')
  },

  /** `goto <hash>`: e.g. #/conversation, #/settings?tab=voice, #/ */
  async goto(hash) {
    need()
    await page.evaluate((h) => (location.hash = h), hash)
    await page.waitForTimeout(800)
    return page.evaluate(() => location.hash)
  },

  /** Type the DashScope key (env DASHSCOPE_API_KEY, else .env) into 设置 → 语音, then open 对话模式 */
  async dashscope() {
    need()
    let key = process.env.DASHSCOPE_API_KEY
    if (!key) {
      const line = envLines().find((l) => /DASHSCOPE_API_KEY=/.test(l))
      if (!line) throw new Error('no DASHSCOPE_API_KEY in env or .env')
      key = envValue(line, 'DASHSCOPE_API_KEY')
    }
    await page.evaluate(() => (location.hash = '#/settings?tab=voice'))
    const input = page.locator('input[placeholder="输入百炼平台 API Key"]')
    await input.waitFor({ timeout: 10_000 })
    await input.fill(key)
    await sleep(500)
    await page.evaluate(() => (location.hash = '#/conversation'))
    await page.waitForTimeout(1000)
    return `key set (${key.length} chars); at ${await page.evaluate(() => location.hash)}`
  },

  /** `say <text>`: speak through the speakers (macOS `say`) for system-audio recognition */
  say(text) {
    const r = spawnSync('say', ['-v', SAY_VOICE, text])
    return r.status === 0 ? 'spoken' : `say failed: ${r.stderr}`
  },

  async hints() {
    need()
    return JSON.stringify(await page.evaluate(HINT_STATE), null, 1)
  },

  /** `waithints [seconds]`: until a hint card exists and none is still generating */
  async waithints(seconds) {
    need()
    const t0 = Date.now()
    const until = t0 + Number(seconds || 60) * 1000
    while (Date.now() < until) {
      const cards = await page.evaluate(HINT_STATE)
      if (cards.length > 0 && cards.every((c) => !c.busy)) {
        return `${((Date.now() - t0) / 1000).toFixed(1)}s\n` + JSON.stringify(cards, null, 1)
      }
      await sleep(500)
    }
    return 'TIMEOUT\n' + JSON.stringify(await page.evaluate(HINT_STATE), null, 1)
  },

  /** `click-text <text>`: click a button / link / summary by its text */
  async 'click-text'(text) {
    need()
    return page.evaluate(clickText, text)
  },

  async eval(expr) {
    need()
    return JSON.stringify(await page.evaluate(expr))
  },

  async text(sel) {
    need()
    return page.evaluate(
      (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
      sel || null
    )
  },

  async windows() {
    if (!app) throw new Error('launch first')
    return app
      .windows()
      .map((w) => w.url())
      .join('\n')
  },

  /** Close the app, delete its userData (it holds the API keys in plain text), exit */
  async quit() {
    if (app) await app.close().catch(() => {})
    if (userData) fs.rmSync(userData, { recursive: true, force: true })
    app = page = userData = problem = null
    setTimeout(() => process.exit(0), 100)
    return 'bye'
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const cmd = decodeURIComponent(url.pathname.slice(1))
    const fn = COMMANDS[cmd]
    let out
    try {
      out = fn
        ? await fn(url.searchParams.get('a') ?? '')
        : `unknown: ${cmd}; try one of: ${Object.keys(COMMANDS).join(', ')}`
    } catch (e) {
      out = 'ERROR: ' + e.message
    }
    res.end(String(out) + '\n')
  })
  .listen(PORT, '127.0.0.1', () =>
    console.log(`driver ready on ${PORT}; screenshots in ${SHOT_DIR}`)
  )

process.on('SIGINT', () => COMMANDS.quit())
process.on('SIGTERM', () => COMMANDS.quit())
