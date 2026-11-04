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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const PROBLEM_HTML = `<html><body style="font:22px/1.6 -apple-system,sans-serif;padding:60px 80px;background:#fff;color:#111">
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

  /** Fill the screen under the cursor with a coding problem, so a screenshot captures it */
  async problem() {
    need()
    return app.evaluate(({ BrowserWindow, screen }, html) => {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const win = new BrowserWindow({ ...display.workArea, show: false, focusable: false })
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      win.once('ready-to-show', () => win.showInactive())
      globalThis.__problemWin = win
      return `problem window on display ${display.id}`
    }, PROBLEM_HTML)
  },

  async closeproblem() {
    need()
    return app.evaluate(() => {
      globalThis.__problemWin?.destroy()
      return 'closed'
    })
  },

  /** `action <name>`: a shortcut action, e.g. takeScreenshot / appendScreenshot / stopSolutionStream */
  async action(name) {
    need()
    const ok = await page.evaluate((n) => window.api.triggerAction(n), name)
    return ok
      ? `triggered ${name}`
      : `refused ${name} (not a toolbar button of the mode on screen, TOOLBAR_LAYOUT in src/shared/toolbar.ts)`
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
    app = page = userData = null
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
