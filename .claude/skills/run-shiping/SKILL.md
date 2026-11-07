---
name: run-shiping
description: Build, run, and drive the shiping Electron app (识屏, formerly interview-coder-cn). Use when asked to start or run the app, take a screenshot of it, test or verify a change in the real app (截图模式 answers, 思考过程, 追问, 追加截图, 对话模式 hints), or click around its UI with a real AI model.
---

shiping (识屏) is an Electron overlay app. Agents drive the **built** app with
`.claude/skills/run-shiping/driver.mjs`: a Playwright `_electron` driver that listens
for commands on `localhost:47123` (`curl`), takes screenshots, and talks to the real AI platform
configured in `.env`. Each launch gets a throwaway userData dir, so your own settings are never
touched.

All paths are relative to the repo root. Verified on macOS (the app targets macOS and Windows
only; Windows not tried).

## Prerequisites

- macOS with Node 24 (`node -v`), `curl`, and `say` for 对话模式.
- Screen Recording permission for `node_modules/electron/dist/Electron.app` - it was already
  granted on the machine this was verified on.
- `.env` at the repo root with an API key. The driver can pick a commented-out block from it (see
  `launch` below); 对话模式 also needs a `DASHSCOPE_API_KEY` line (commented is fine).

## Setup

```bash
npm install
npm i --no-save playwright-core
```

`npm install` removes `playwright-core` again (it is not in `package.json`), so rerun the second
line after every `npm install`.

## Build

The driver launches `out/` (`package.json` `main`), not `src/`. Rebuild after every change -
`launch` prints a WARNING when `src/` is newer than `out/`:

```bash
npx electron-vite build
```

## Run (agent path)

Start the driver in the background, wait for it, launch the app. `MODEL` / `API_BASE_URL` /
`API_KEY` in the driver's environment beat `.env`; `launch?a=openrouter` takes the `.env`
`API_BASE_URL` line containing `openrouter` (commented or not) plus the `API_KEY` line after it:

```bash
MODEL=openai/gpt-6-sol node .claude/skills/run-shiping/driver.mjs > /tmp/run-shiping-driver.log 2>&1 &
until curl -s localhost:47123/ping >/dev/null; do sleep 0.3; done
curl -s 'localhost:47123/launch?a=openrouter'
```

`launch` answers with the header (`截屏解答 … 解算法题 · openai/gpt-6-sol …`) - check the model
there.

**截图模式** - put a known problem on screen, screenshot it, follow the answer, ask a follow-up.
Read **Capture safety** below first: a capture that misses the problem sends the user's desktop
to the AI platform.

```bash
curl -s localhost:47123/problem   # must end with CHECK OK
curl -s 'localhost:47123/action?a=takeScreenshot'
curl -s 'localhost:47123/watch?a=120'
curl -s 'localhost:47123/ss?a=answer'
curl -s localhost:47123/followup --get --data-urlencode 'a=如果数组已经有序，能否做到 O(1) 额外空间？'
curl -s 'localhost:47123/watch?a=120'
```

`watch` prints one line per change of the 思考过程 blocks (`[label, open, streaming, height]`,
with a screenshot each) and returns once the answer settles.

### Capture safety

Every screenshot the app takes goes to the AI platform, and whatever is on the real screen goes
with it. On a machine with a second screen an unguarded capture took the user's other screen.
The app captures the screen under the **cursor**, and the cursor belongs to the user, who may
have moved it. The picker (框选) also opens one window per screen. So:

- `problem` never follows the cursor. It opens the problem window on the main window's screen,
  always on top, and sets the app's **capture region** to it. `takeScreenshot` /
  `appendScreenshot` then crop to the problem, whichever screen the cursor is on.
- `problem` ends with `check`. It captures the region locally and compares it with the problem
  page's own rendering, so anything else in front of the problem fails. `action`
  (`takeScreenshot` / `appendScreenshot`) and `snip` run `check` first and refuse if it fails.
  They also refuse with no `problem` up.
- `snip` drags only inside the problem, on the picker of the problem's screen.
  `action?a=snipScreenshot` is refused: it would leave the drag to nobody.
- A failing capture is dropped unseen and reported only as the differing cells of a 12 x 8
  grid, since it may hold the user's windows. Don't look for it. Ask the user to clear the
  problem window, then run `check` again.
- `cover` / `cover?a=off` put an opaque window over a corner of the problem. `check` must say
  `CHECK FAILED` while it is up. Run it after changing the guard.
- `screens` lists the screens, the cursor and the app's windows without capturing anything.
- Never call `window.api.triggerAction` / `takeScreenshot` through `eval`: that bypasses the
  guard.
- `check` covers the moment it runs. A notification or another app's window landing on the
  problem between the check and the capture is not caught. So before driving the real app, tell
  the user in one sentence that testing is about to start and wait for their go: they clear the
  screen for it. No need to open each screenshot sent afterwards.
- Delete the screenshots in `$TMPDIR/run-shiping/shots/` when done (`rm -f …/shots/*.png`). The
  `ss` / `watch` images show the gallery thumbnails of what was captured.

**对话模式** - set the DashScope key, listen, speak a question through the speakers (audible),
wait for the hint card:

```bash
curl -s localhost:47123/dashscope
curl -s localhost:47123/click-text --get --data-urlencode 'a=开始监听'
sleep 3
curl -s localhost:47123/say --get --data-urlencode 'a=请你讲一下，TCP 三次握手为什么不能是两次？'
curl -s 'localhost:47123/waithints?a=60'
curl -s localhost:47123/click-text --get --data-urlencode 'a=停止监听'
```

**Stop** - always through the driver: `quit` deletes the userData dir, which holds the API keys in
plain text:

```bash
curl -s localhost:47123/quit
```

Screenshots land in `$TMPDIR/run-shiping/shots/` (`SCREENSHOT_DIR` overrides); the
app's stdout/stderr in `$TMPDIR/run-shiping/app.log`. Open the screenshots and look.

| command (`curl -s 'localhost:47123/<cmd>?a=<arg>'`) | what it does                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ping`                                              | `pong` once the driver is listening                                                                                |
| `launch[?a=<.env block>]`                           | start the app on a fresh userData dir                                                                              |
| `ss?a=<name>`                                       | screenshot of the main window -> `<name>.png`                                                                      |
| `problem` / `closeproblem`                          | a 两数之和 window on the main window's screen, captures pinned to it, then `check` / remove it                     |
| `check`                                             | would a capture now see only the problem? (captures locally, sends nothing)                                        |
| `cover[?a=off]`                                     | an opaque window over a corner of the problem, to prove `check` fails                                              |
| `screens`                                           | screens, cursor and the app's windows, captures nothing                                                            |
| `action?a=<name>`                                   | run a shortcut action: `takeScreenshot`, `appendScreenshot`, `stopSolutionStream`, … (captures only after `check`) |
| `snip?a=[append][+shift]`                           | 框选识别 / 框选追加截图: drag inside the problem, Shift held on release swaps 「框选后」                           |
| `winstate`                                          | the main window as main sees it: visible, focused, bounds                                                          |
| `toolbar?a=<name>`                                  | the overlay toolbar's bounds, visibility and button count; screenshot -> `<name>.png`                              |
| `followup?a=<question>`                             | 追问 in the current 截图模式 conversation                                                                          |
| `state`                                             | 截图模式: 思考过程 blocks, loading flag, end of the answer                                                         |
| `watch?a=<seconds>`                                 | follow an answer until it settles, screenshotting block changes                                                    |
| `goto?a=<hash>`                                     | navigate: `#/`, `#/conversation`, `#/settings?tab=voice`, …                                                        |
| `dashscope`                                         | type `DASHSCOPE_API_KEY` (env, else `.env`) into 设置 → 语音, open 对话模式                                        |
| `say?a=<text>`                                      | speak through the speakers (`SAY_VOICE`, default Tingting)                                                         |
| `hints` / `waithints?a=<seconds>`                   | 对话模式 cards (meta, busy, reasoning, text) / wait until all finished                                             |
| `click-text?a=<text>`                               | click a button, link or summary by its text                                                                        |
| `eval?a=<js>` / `text[?a=<css>]`                    | evaluate in the page / print innerText                                                                             |
| `windows`                                           | URLs of the app's windows                                                                                          |
| `quit`                                              | close the app, delete its userData, stop the driver                                                                |

Pass Chinese or spaces with `--get --data-urlencode 'a=…'`.

## Run (human path)

`npm run dev` (README) opens the app with hot reload on your real settings
(`~/Library/Application Support/shiping`). Not used by agents.

## Test

There is no unit test suite; these are the checks:

```bash
npm run typecheck
npm run lint
```

Both exit 0 on a clean tree.

## Gotchas

- **Settings live in the renderer's localStorage and win over `.env`.** The driver passes
  `--user-data-dir=<fresh dir>` (Electron honors it), so every launch starts from `.env` defaults
  and the real `~/Library/Application Support/shiping` is never read or written.
- **The app reads `.env` itself** (dotenv, cwd = repo root). `MODEL="gpt-5-mini"` there applies
  unless the driver gets `MODEL=`; dotenv never overrides variables already set.
- **Global shortcuts can't be pressed from Playwright.** `action` calls
  `window.api.triggerAction`, which only accepts the toolbar buttons of the mode on screen
  (`TOOLBAR_LAYOUT` in `src/shared/toolbar.ts`, ticked or not); anything else comes back `refused`.
- **A screenshot captures the real screen under the cursor**; the app's own windows are left out by
  content protection. See **Capture safety**: `problem` pins captures to its own window instead.
- **zsh globs an unquoted `?`**: `curl -s $W/action?a=…` fails with `no matches found` and runs
  nothing. Quote every URL with a query.
- **Content protection does not block `ss`**: Playwright renders through CDP, not OS capture.
- **Two windows**: the main one and the overlay toolbar (`index.html#toolbar`); the driver picks
  the main one.
- **No spinner to wait on**: a 追问 runs with `showLoading: false`, and a 对话模式 card drops its
  spinner at the first text chunk. `watch` waits for the text to stop growing; `waithints` waits
  for the card's latency (`自动 · 1.7s`), which only appears once it is finished.
- **Reasoning is not guaranteed.** `openai/gpt-6-sol` via OpenRouter sends a 思考过程 summary only
  sometimes - repeat `action?a=takeScreenshot`, or `click-text?a=出提示` in 对话模式, until one
  comes.
- **The DashScope key is not read from env** (`dashscopeApiKey: ''` in `src/main/settings.ts`), so
  `dashscope` types it into the settings page.
- **对话模式 hears system audio** (`getDisplayMedia` loopback), so `say` through the speakers is
  recognised - and is audible to whoever is at the machine.
- **No tmux on the verified Mac**, hence the HTTP port instead of a stdin REPL. A driver started
  with `&` keeps running after the shell that started it exits.

## Troubleshooting

- **`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright-core'`**: an `npm install`
  pruned it. `npm i --no-save playwright-core`.
- **`zsh: no matches found: localhost:47123/ss?a=…`**: zsh globbed the `?`. Quote the URL.
- **Header shows `gpt-5-mini` instead of the model you wanted**: `.env`'s `MODEL` won. Start the
  driver with `MODEL=<id>`.
- **`sandbox_extension_issue_file failed … Operation not permitted` in `app.log`**: harmless noise
  from the unpacked Electron.app.
