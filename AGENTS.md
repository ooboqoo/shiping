# AGENTS.md

## Project Overview

**识屏 Shiping** (package `shiping`; called 截屏解题助手 / interview-coder-cn until 2026-10, see Legacy Name) is a desktop application that captures screenshots of whatever is on screen (coding challenges, exam questions, code, error messages, charts, foreign-language text, or anything else) and uses AI (vision models) to answer about it in real-time. The window is invisible to screen-sharing software, so it stays usable while the screen is shared.

Key capabilities:
- Global shortcuts trigger screenshot capture → AI analysis → streamed solution display
- Frameless, transparent, always-on-top overlay window invisible to screen-sharing
- Mouse passthrough mode (window ignores mouse events)
- Multi-screenshot conversation continuity (append screenshots to existing context)
- Follow-up questions within the same conversation
- Real-time speech transcription (DashScope Fun-ASR) — transcribed text is attached to screenshots when sent to AI
- 资料库: the user's own material (resume, prepared Q&A, notes; imported from PDF / Word / Markdown / TXT or pasted) goes in front of each mode's system prompt
- 对话模式 (conversation mode): a second page for voice interviews — the other side's sentences on the left, short AI hints on the right, no screenshots; hints come automatically when a sentence ends or on a shortcut
- 手机同步: 截图模式's answer and 对话模式's hints mirrored read-only to a phone's browser — over the LAN (the app serves the page, scan a QR code) or through the user's own public relay (`relay/`)
- Configurable AI provider (OpenAI, SiliconFlow, OpenRouter, or any OpenAI-compatible API)
- 网络代理: AI requests follow the system proxy (PAC included) by default, or go through a custom HTTP / HTTPS / SOCKS5 proxy, or direct

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 37 (electron-vite 4) |
| Frontend | React 19, TypeScript 5.8 |
| Styling | Tailwind CSS v4, shadcn/ui (New York style), Radix primitives |
| State | Zustand 5 (6 stores, 2 with localStorage persistence) |
| Routing | react-router v7 (HashRouter: `/` 截图模式, `/conversation` 对话模式, `/settings`, `/help`, plus `/toolbar` for the toolbar window) |
| AI | Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`), streaming via `streamText()` |
| Build | electron-vite (Vite 7), electron-builder 25 |
| Linting | ESLint 9 (flat config), Prettier |

## Directory Structure

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # App entry: lifecycle, error handling, app.whenReady()
│   ├── legacy-name.ts       # Imported first: moves the userData folder named after the old package name
│   ├── main-window.ts       # BrowserWindow creation (frameless, transparent, always-on-top)
│   ├── toolbar-window.ts    # Overlay toolbar window: bounds/visibility/opacity glued to main window
│   ├── shortcuts.ts         # Global shortcuts registration + 截图模式 AI streaming orchestration (largest file)
│   ├── conversation.ts      # 对话模式: utterances, hint cards, automatic / manual hint triggering
│   ├── stream.ts            # consumeStream() shared by both modes (answer and reasoning chunks), API error messages, image-refusal detection
│   ├── ai.ts                # Vercel AI SDK integration, one streaming function per request kind, each with its mode's profile
│   ├── knowledge.ts         # 资料库: material on disk under userData, IPC, the system prompt block per mode
│   ├── knowledge-parse.ts   # Text out of an imported PDF (unpdf) / .docx (mammoth) / Markdown / TXT (UTF-8, UTF-16, GBK)
│   ├── thinking.ts          # 「关闭思考」: per-platform request-body fields + retry without them when refused
│   ├── model-list.ts        # `listModels` IPC: a platform's `/models` list (+ SiliconFlow vision flags scraped from its public model square)
│   ├── api-fetch.ts         # apiFetch: the one transport of AI requests and model lists, through the 网络代理 setting
│   ├── proxy.ts             # 网络代理: one in-memory Electron session per proxy setting, the connection test and system proxy detection
│   ├── proxy-ipc.ts         # `proxy:detect` / `proxy:test` IPC (kept apart so tests load proxy.ts without ipcMain)
│   ├── mobile-sync.ts       # 手机同步: builds the phone state from registered sources, LAN server (relay core in-process) + relay host client
│   ├── raw.d.ts             # `*?raw` imports (the phone page, inlined from relay/public)
│   ├── settings.ts          # App settings object + IPC handlers
│   ├── state.ts             # App state object + IPC handlers
│   ├── take-screenshot.ts   # desktopCapturer → base64 PNG of the screen under the cursor or a fixed one, cropped to `captureRegion`; `getDisplays` IPC
│   ├── region-picker.ts     # One full-screen window per screen to drag out the capture region, or a one-off screenshot's area
│   ├── save-screenshot.ts   # Optional auto-save of each screenshot to a folder
│   ├── save-code.ts         # First code block of a finished answer → clipboard and/or source file
│   ├── save-conversation.ts # 对话模式's conversation → one Markdown file per conversation
│   ├── transcription.ts     # DashScope WebSocket real-time speech-to-text (截图模式 text or 对话模式 sentences)
│   ├── window-resize.ts     # Cursor-tracking resize for the frameless windows
│   ├── tray.ts              # Tray icon (menu bar / notification area): click = 框选识别, right-click menu (`hideTrayIcon`)
│   ├── auto-updater.ts      # New releases, announced in the window: Windows installs via electron-updater, macOS links to the page
│   └── index.d.ts           # global.mainWindow type declaration
├── preload/
│   ├── index.ts             # contextBridge API: exposes window.api to renderer
│   └── index.d.ts           # Type declarations for window.electron and window.api
├── shared/                  # Pure TS used by both main and renderer (no Electron / DOM / Node imports)
│   ├── request-headers.ts   # Parse the custom request headers text, merge it over the Bearer key
│   ├── capture-region.ts    # CaptureRegion type + fractions → pixels, for main's crop and the picker's readout
│   ├── api-profile.ts       # ApiProfile + AppMode types
│   ├── knowledge.ts         # KnowledgeDoc type, the suggested per-mode limit, estimateTokens()
│   ├── update.ts            # AvailableUpdate: a newer release main found, and how far its download got
│   ├── conversation.ts      # 对话模式 types (Utterance, HintCard, HintMode) + countMeaningfulChars()
│   ├── proxy.ts             # 网络代理: ProxySettings + normalizeProxySettings() (validated on both sides of IPC), modelsURL()
│   └── mobile.ts            # 手机同步: MobileState (what phones get) + MobileSyncStatus (for the settings page)
└── renderer/
    ├── index.html            # SPA entry
    ├── picker.html           # The region picker's own page (entry `src/picker.tsx`)
    └── src/
        ├── main.tsx          # React root render
        ├── App.tsx           # Router + settings sync + shortcut init + Toaster
        ├── coder/            # 截图模式 page: screenshot display + AI solution stream
        │   ├── index.tsx     # CoderPage layout + transcription lifecycle
        │   ├── AppHeader.tsx # Draggable title bar: mode switch, scene · model, nav buttons (shared by both modes)
        │   ├── AppContent.tsx# Screenshots gallery + markdown solution + error banner
        │   ├── AppStatusBar.tsx    # Loading indicator + request timer, follow-up dialog, shortcut hints
        │   ├── TranscriptionBar.tsx # Absolute-positioned real-time transcription overlay
        │   ├── OverlayToolbar.tsx  # Contents of the toolbar window (route `/toolbar`)
        │   └── PrerequisitesChecker.tsx  # Modal for API key setup
        ├── conversation/     # 对话模式 page (`/conversation`)
        │   ├── index.tsx     # Layout + snapshot / event sync with main's conversation
        │   ├── TranscriptPanel.tsx # The other side's sentences; a hovered hint highlights its own
        │   ├── HintPanel.tsx       # Hint cards + empty states
        │   ├── ConversationStatusBar.tsx # Listening, 自动/手动, hint / stop buttons with shortcuts
        │   └── listening.ts  # Start / stop recognition (`purpose: 'conversation'`), toggle hint mode
        ├── settings/         # Settings page: left nav, one group at a time (`?tab=`)
        │   ├── index.tsx     # Shell: nav (通用: AI 模型 / 网络代理 / 资料库 / 语音 / 界面与隐私 / 手机同步 / 快捷键; 模式: 截图模式 / 对话模式)
        │   ├── sections/     # One component per nav entry
        │   ├── components.tsx      # SettingsCard, Field, SaveDirField, Advanced (folded), SecretInput
        │   ├── SceneEditor.tsx     # One mode's prompt scenes: pick, edit, add, delete, restore
        │   ├── ModeProfileSelect.tsx # Which saved profile a mode uses (截图模式 refuses text-only ones)
        │   ├── KnowledgeField.tsx  # A mode's share of the 资料库, linking to it
        │   ├── ApiProfiles.tsx     # Saved AI profiles: open, add, rename, remove, assign to modes (「用于」)
        │   ├── ModelField.tsx      # Model row: picker + mismatch warning with one-click fix
        │   ├── ApiHeadersField.tsx # Custom request headers textarea + ignored-line warning
        │   ├── CaptureTargetFields.tsx # Which screen to capture (cursor / fixed) + the optional capture region
        │   ├── SelectModel.tsx     # Model combobox that follows the API Base URL
        │   ├── SelectBaseURL.tsx   # API Base URL combobox (presets from lib/providers.ts)
        │   └── CustomShortcuts.tsx # Shortcut key recorder
        ├── picker.tsx        # Entry of picker.html: the region picker alone, without App
        ├── region-picker/    # One screen of the capture-region picker
        ├── help/             # Help page
        │   ├── index.tsx     # Quick start guide, shortcuts, toolbar, FAQ
        │   ├── Shortcuts.tsx
        │   ├── OverlayToolbar.tsx  # Toolbar section (buttons + meanings + shortcuts)
        │   ├── FAQ.tsx
        │   ├── UpdateNotice.tsx    # 发现新版本 card in 简介: download / install on Windows, release page on macOS
        │   └── components/index.tsx  # HelpSection wrapper
        ├── components/
        │   ├── MarkdownRenderer.tsx   # react-markdown + remark-gfm + rehype-highlight + KaTeX math
        │   ├── ShortcutRenderer.tsx   # Platform-aware shortcut key badges
        │   ├── WindowResizeHandles.tsx # Edge/corner drag targets that drive window-resize.ts
        │   └── ui/           # shadcn/ui primitives (button, dialog, select, etc.)
        ├── lib/
        │   ├── store/        # Zustand stores
        │   │   ├── app.ts       # ignoreMouse / inConversationPage, synced from main process
        │   │   ├── conversation.ts # 对话模式 page copy of main's utterances + hint cards
        │   │   ├── settings.ts  # API config, model, prompt scenes, opacity, toolbar (persisted v8)
        │   │   ├── shortcuts.ts # Shortcut bindings (persisted v5, with migration)
        │   │   ├── solution.ts  # Loading state, solution chunks, screenshots, errors
        │   │   └── transcription.ts # Transcription state: isTranscribing, text, error
        │   ├── toolbar-actions.ts # Toolbar button lists per mode (action + icon + label), shared with help
        │   ├── use-mode-page.ts   # useModePage(): what both mode pages do alike; MODE_PATHS / MODE_NAMES
        │   ├── providers.ts  # Known platforms + each one's spelling of the same model
        │   ├── platform-models.ts # usePlatformModels(): cached `/models` list per URL + key
        │   ├── model-switch.ts    # changeApiBaseURL(): switch URL, toast the linked model change
        │   ├── knowledge.ts       # useKnowledgeDocs() (the list from main), per-mode usage, 字 / token formatting
        │   ├── api-profiles.ts    # ApiProfile type + factory (one saved URL / key / model set)
        │   ├── use-elapsed.ts     # Status bar timer: local tick while loading, main's measured value after
        │   ├── utils/
        │   │   ├── index.ts     # cn() helper, getCloneableFields()
        │   │   ├── env.ts       # isMac, platformAlt
        │   │   ├── duration.ts  # formatDuration(): 3s / 1m05s
        │   │   └── keyboard.ts  # Accelerator string conversion
        │   └── audio-capture.ts # System audio capture via getDisplayMedia for transcription
        └── assets/
            ├── base.css      # Tailwind @import, CSS variables, app layout styles
            └── main.css      # Tailwind + typography plugin + theme variables (oklch)

tests/                       # `npm test` (node:test) and `npm run test:proxy` (real Electron network stack); not shipped in the app
├── load-source.cjs          # Runs checked-in TS by transpiling it with `typescript`, with per-test mocks for imports
├── proxy.test.cjs           # Unit tests: proxy settings, transport wiring, error messages, settings store
└── electron-proxy.cjs       # Started by run-electron.cjs: local HTTP / SOCKS5 proxies against real sessions

relay/                       # 手机同步's relay + phone page: its own package (`ws` only), not shipped in the app
├── relay.mjs                # createRelay(): HTTP + WebSocket core, used by server.mjs and in-process by mobile-sync.ts
├── server.mjs               # The public relay: `RELAY_KEY=… node server.mjs`
├── public/                  # The phone page (plain JS, vendored marked); also inlined into main with `?raw`
└── README.md                # Deployment (Docker / Node), in Chinese
```

## Architecture

### Process Model

```
┌─────────────────────────────────────────────────────┐
│  Main Process (src/main/)                           │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ settings │  │  state   │  │    shortcuts.ts    │ │
│  │   .ts    │  │   .ts    │  │  (orchestrator)   │ │
│  └────┬─────┘  └────┬─────┘  │  - global hotkeys │ │
│       │              │        │  - AI streaming   │ │
│       │              │        │  - conversation   │ │
│       │              │        │    management     │ │
│       │              │        └──┬───────────┬────┘ │
│       │              │           │           │      │
│       │              │     ┌─────┴──┐  ┌─────┴────┐ │
│       │              │     │ ai.ts  │  │take-     │ │
│       │              │     │        │  │screenshot│ │
│       │              │     └────────┘  └──────────┘ │
│       └──────────────┼───────────┘                  │
│              IPC (ipcMain.handle)                    │
├─────────────────────────────────────────────────────┤
│  Preload (src/preload/)                             │
│  contextBridge → window.api                         │
├─────────────────────────────────────────────────────┤
│  Renderer (src/renderer/)                           │
│  React app with Zustand stores                      │
│  window.api.on*() for events from main              │
│  window.api.*() for invoke calls to main            │
└─────────────────────────────────────────────────────┘
```

### Data Flow: Screenshot → Solution

1. User presses global shortcut (e.g., `Alt+Enter` on macOS)
2. `shortcuts.ts` callback triggers `takeScreenshot()` → `desktopCapturer` → base64 PNG. It captures the screen under the cursor, or the one fixed in `captureScreen` (a `Display.id`; a disconnected one falls back to the cursor), matching the source by `display_id` — `desktopCapturer` returns screens in no particular order. A `captureRegion` overrides the screen choice and crops the capture (see Capture Region)
3. Main sends `screenshot-taken` and `ai-loading-start` to renderer
4. Main calls `getSolutionStream(base64Image)` → Vercel AI SDK `streamText()`
5. Answer chunks sent to renderer via `solution-chunk` IPC events, a thinking model's reasoning via `reasoning-chunk`
6. Renderer accumulates chunks in `useSolutionStore` and renders via `MarkdownRenderer`, each request's reasoning in a folding block above its answer
7. On completion: `solution-complete`; on error: `solution-error`; on abort: `solution-stopped`

### IPC Channels

**Renderer → Main (invoke):**
- `getAppSettings` / `updateAppSettings` — settings CRUD
- `listModels` — fetch the model list of an OpenAI-compatible platform (runs in main to avoid CORS)
- `proxy:detect` / `proxy:test` — 网络代理: the system proxy's route for the edited profile's URL; a draft proxy setting tried on that profile's `/models` (10s, saves nothing)
- `getDisplays` — connected screens (numbered left to right) for the capture-screen picker
- `pickCaptureRegion` — cover every screen with a region picker; resolves with the region, or null if cancelled
- `getRegionPickerData` / `region-picker-ready` / `finish-region-picker` (the last two `send`) — a picker window fetches its frozen screen, asks to be shown once painted, and reports the result
- `updateAppState` / `getAppState` — sync `inCoderPage`, `inConversationPage`, `inSettingsPage`; the toolbar window fetches it on load
- `setIgnoreMouse` — set click-through from the settings page switch
- `initShortcuts` / `getShortcuts` / `updateShortcuts` — shortcut management; `getShortcuts` also says which keys another app holds (`failed`)
- `setShortcutRecording` — the settings page is recording a key: main releases every key meanwhile
- `stopSolutionStream` — abort current AI stream
- `hideMainWindow` — the header's 隐藏 and Esc after 框选识别: hide as the shortcut does, handing the keyboard back
- `sendFollowUpQuestion` — follow-up within conversation
- `triggerAction` / `setToolbarVisible` — overlay toolbar: run a shortcut action, toggle the window
- `selectScreenshotDir` / `selectCodeDir` / `selectConversationDir` — folder pickers for the auto-save settings
- `window-resize-start` / `window-resize-stop` (`send`, not `invoke`) — begin/end a cursor-tracked window resize
- `start-transcription` / `stop-transcription` — speech transcription lifecycle; start takes `{ purpose, maxSentenceSilence }`
- `conversation:get-snapshot` / `conversation:request-hint` / `conversation:stop-hints` / `conversation:clear` — 对话模式
- `get-transcription-text` / `clear-transcription-text` — read/clear accumulated text
- `update:get-status` / `update:download` / `update:install` — a newer release; the last two are Windows only
- `knowledge:list` / `knowledge:get-text` / `knowledge:pick-files` / `knowledge:import-files` / `knowledge:create` / `knowledge:update` / `knowledge:reimport` / `knowledge:remove` — 资料库; imports and reimports return their failures as values, not rejections
- `mobile:get-status` — 手机同步: each path's state, the viewer links (LAN: one per local address, best first) and phone counts; polled by the settings page

**Main → Renderer (send):**
- `sync-app-state` — push state changes (e.g., mouse ignore toggle) to both the main and the toolbar window
- `screenshot-taken` / `screenshots-updated` — screenshot data (`screenshots-updated` also carries the untruncated conversation total)
- `solution-clear` / `solution-chunk` / `solution-complete` / `solution-stopped` / `solution-error` — AI streaming lifecycle
- `reasoning-chunk` / `reasoning-round-start` — a thinking model's reasoning, streamed above the answer; a later request (appended screenshot, follow-up) starts a new round with its own block
- `ai-loading-start` / `ai-loading-end` — loading state
- `solution-duration` — how long the finished request took (ms), timed in main from the key press
- `switch-api-profile` — step the current mode's AI profile (`1` / `-1`); the list lives in the renderer store
- `cycle-scene` — step the current mode to its next prompt scene; the renderer owns the list and syncs the new prompt back
- `switch-mode` — show the other mode's page (shortcut / toolbar); the renderer owns the routes
- `open-settings` — the tray menu's 设置…: main has already revealed the window
- `snip-session` — 框选识别's answer is up and the window holds the keyboard (`true`), or no longer: 截图模式 hides on Esc meanwhile
- `vision-unsupported` — a screenshot was refused for want of image input (profile id); the renderer marks the profile text-only if nothing better is known
- `toggle-hint-mode` — flip 对话模式 between automatic and manual hints; the renderer owns the setting
- `conversation-utterance` / `conversation-utterance-removed` / `conversation-hint` / `conversation-hint-chunk` / `conversation-cleared` / `conversation-notice` — 对话模式 state from main
- `thinking-unsupported` — the active model refused 「关闭思考」 (model name); sent once per model per session, the request has already been resent without it
- `capture-region-picked` — a new capture region, from whichever entry point started the pick
- `update-status` — a newer release was found, or its download moved on
- `scroll-page-up` / `scroll-page-down` — keyboard-driven scroll
- `toggle-transcription` — trigger start/stop transcription from shortcut
- `sync-toolbar-settings` — push toolbar-only settings (hover dwell) into the toolbar window
- `transcription-text` / `transcription-error` / `transcription-stopped` / `transcription-cleared` — transcription events

### Zustand Stores

| Store | File | Persisted | Key State |
|-------|------|-----------|-----------|
| `useSettingsStore` | `lib/store/settings.ts` | Yes (v8) | `apiProfiles`, `activeProfileId` (the one being edited), `screenshotProfileId`, `conversationProfileId`, `hasConfiguredApi`, `apiBaseURL`, `apiKey`, `apiHeaders`, `model`, `disableThinking` (mirror of the edited profile), `customModels`, `customModelsByBaseURL`, `modelByBaseURL`, `scenes` (prompt scenes, each with a `mode`), `activeSceneId` / `conversationSceneId`, `customPrompt` / `conversationPrompt` (derived from each mode's scene), `lastMode`, `conversationHintMode`, `conversationSilenceMs`, `conversationMinChars`, `conversationTranscriptHidden`, `conversationAutoSave`, `conversationSaveDir`, `opacity`, `resizable`, `showOverlayToolbar`, `toolbarHoverDelay`, `hideShortcutHints`, `screenshotDisplay`, `captureScreen`, `captureRegion`, `screenshotAutoSave`, `screenshotDir`, `codeAutoSave`, `codeSaveDir`, `codeFileBaseName`, `codeNamingMode`, `codeCopyToClipboard`, `dashscopeApiKey`, `mobileLanEnabled`, `mobileLanKey`, `mobileRelayEnabled`, `mobileRelayURL`, `mobileRelayKey`, `networkProxy`, `hideDockIcon`, `hideTrayIcon` |
| `useShortcutsStore` | `lib/store/shortcuts.ts` | Yes (v5) | `shortcuts` (action → key mapping with categories); `merge` adds new default actions on every load, so a new shortcut needs no `version` bump |
| `useSolutionStore` | `lib/store/solution.ts` | No | `isLoading`, `solutionChunks`, `reasoningRounds`, `liveRound`, `roundUi`, `screenshotData`, `errorMessage`, `durationMs` |
| `useTranscriptionStore` | `lib/store/transcription.ts` | No | `isTranscribing`, `transcriptionText`, `errorMessage` |
| `useConversationStore` | `lib/store/conversation.ts` | No | `utterances`, `hints`, `errorMessage`, `focusedHintId` |
| `useAppStore` | `lib/store/app.ts` | No | `ignoreMouse`, `inConversationPage`, `update` (a newer release, from main) |

Settings are bidirectionally synced: renderer persists to localStorage, and on mount syncs to main process via `updateAppSettings()`. Main process `.env` values serve as initial defaults only.

Adding a settings key needs no `version` bump: zustand shallow-merges the persisted object over the defaults, so a key missing from localStorage falls back to its default. Bump `version` only when an existing key changes shape or meaning.

## Key Patterns & Conventions

### Window Stealth

`stealthEnabled` defaults to `true`, is persisted by the renderer, and can be toggled in 「界面与隐私 → 隐身模式」 without restarting. `src/main/window-privacy.ts` registers the main window, toolbar and region pickers so current and newly created windows follow it. Disabling restores capture visibility and window titles, plus the main window's taskbar / Mission Control entry; `hideDockIcon` and `hideTrayIcon` remain independent. Startup settings sync must not overwrite a persisted `false` with main's `true` default.

When enabled, the app is designed to be invisible to screen-sharing software:
- `BrowserWindow` options: `transparent: true`, `frame: false`, `skipTaskbar: true`
- `setContentProtection(true)` prevents screen capture of the window itself
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`
- macOS: the main window, the toolbar and the region pickers are `type: 'panel'`. A regular app's window shows over another app's fullscreen Space only if its Spaces flags were set while the app had no Dock icon, and the Dock icon is on by default (`hideDockIcon`); a non-activating panel is let in either way. Clicking it still activates the app, so typing and dialogs work as before
- `keepWindowInFront()` repeatedly reasserts always-on-top for 5 seconds after show
- `showInactive()` on macOS/Windows to avoid stealing focus

### Overlay Toolbar

A second `BrowserWindow` (`src/main/toolbar-window.ts`) that renders the `/toolbar` route, so the shortcut actions can be driven with the mouse instead of the keyboard:
- Owns its own visibility state: the renderer calls `setToolbarVisible()` (main page + `showOverlayToolbar` setting), main additionally requires the main window to be visible. Never call `showInactive()` on it directly — go through `showToolbar()` / `hideToolbar()`.
- The window exists only while `showOverlayToolbar` is on (`setToolbarEnabled()` from the settings sync): it is a renderer of its own, about 40 MB. Like the tray icon it is created by the first sync, so code reaching it must allow for no window
- `focusable: false` so clicking a button never pulls focus away from the app underneath
- Opacity is applied at the window level to match the main window, which applies its own via `document.body.style.opacity`
- It is a separate renderer process, so its Zustand store is a **separate copy** that does not see changes made in the main window. Settings it needs must be pushed from main (`sync-toolbar-settings`), not read from the store.
- Buttons carry no `title`: native tooltips are drawn outside the window and are not covered by content protection
- It never receives a `click` on Windows: `focusable: false` makes Chromium answer the press's WM_MOUSEACTIVATE with `MA_NOACTIVATEANDEAT`, so the button-down is dropped by the OS. Only the release and the moves arrive — anything interactive in this window must hang off `mouseup`/`pointermove`, never `click` or `pointerdown`
- `TOOLBAR_ACTIONS` (`lib/toolbar-actions.ts`) holds one list per mode and drives both the toolbar and its help page section; the toolbar picks the list from `inConversationPage` (pushed by main, fetched with `getAppState` on load). `triggerAction` is validated against `clickableActions` in `shortcuts.ts`
- Resizing the toolbar window never rescales its buttons: `OverlayToolbar` measures the bar and renders only the actions that fit, dropping the rest from the end

### Window Resizing

Both windows are created with `resizable: false` — toggling Electron's native resizable style breaks transparency on Windows — so resizing is implemented by hand:
- `WindowResizeHandles` renders eight fixed-position edge/corner divs — or, with `axis="x"`, just the two side edges — and sends only `window-resize-start` (pointerdown) and `window-resize-stop`
- `nonActivating` (the toolbar) also starts the drag from the first pointermove made with the button held, because Windows never delivers that window's pointerdown (see Overlay Toolbar)
- `src/main/window-resize.ts` then polls `screen.getCursorScreenPoint()` and calls `setBounds()`. The cursor is sampled in main because the toolbar is a non-activating panel on macOS and never receives a drag's pointer moves
- The drag is ended by a `window`-level `pointerup`/`pointercancel`/`blur` listener, with a 30s safety timeout in main as the last resort
- The handles sit at `z-index: 2147483647`; anything flush against a window edge (e.g. `#app-header .actions`) must raise itself above them or it becomes unclickable
- The main window's handles are gated by the `resizable` setting; the toolbar's are always on but width-only (`axis="x"` — its height is the button row), with the resize cursor suppressed in `main.css`

### AI Integration

- All AI calls go through `src/main/ai.ts` using Vercel AI SDK's `streamText()`
- Provider: `@ai-sdk/openai-compatible` with custom `baseURL` (works with any OpenAI-compatible API; an empty one means OpenAI, `DEFAULT_API_BASE_URL`). Not `@ai-sdk/openai`: its chat-completions parser drops the `reasoning_content` / `reasoning` deltas thinking models send
- Transport (网络代理): every AI request, thinking-off retry and model list goes through `apiFetch` (`api-fetch.ts`), i.e. `ses.fetch` of an in-memory Electron session set to `networkProxy` (`system` by default, which follows the OS proxy and PAC; `custom` HTTP / HTTPS / SOCKS5; `direct`). Not Node's `fetch`, which ignores the system proxy. One session per distinct setting, created on first use and never changed, so testing a draft or switching proxies never touches a request already streaming, the default session (updater, renderer) or the OS. A failed connection surfaces as Chromium's `net::ERR_…`, which `extractErrorMessage()` turns into a hint pointing at 「设置 → 网络代理」. Transcription, 手机同步 and the update check keep their own connections
- Custom request headers (`apiHeaders`, one `Name: Value` per line) go on every AI request and on the `/models` fetch, through `buildRequestHeaders()` in `src/shared/request-headers.ts`. They override the Bearer key case-insensitively, so a gateway can replace `Authorization`
- Model fallback: `Qwen/Qwen3-VL-32B-Instruct` for SiliconFlow, `gpt-5-mini` otherwise
- AI profiles (`apiProfiles`): each holds its own URL / key / headers / model / thinking switch / `vision` flag. Each mode sends its requests with its own (`screenshotProfileId` / `conversationProfileId`, picked in the mode's settings group or via 「用于」); main resolves it with `getModeProfile(mode)` in `settings.ts`. `activeProfileId` is only the profile open in the AI 模型 editor, mirrored onto the flat `apiBaseURL` / `apiKey` / `apiHeaders` / `model` / `disableThinking` fields the editor binds to (`CREDENTIAL_KEYS`). The profile is authoritative (`reconcileApiProfiles()` restores the flat fields from it on load), so never write those with `updateSetting`: use `updateCredential()`, `changeApiBaseURL()` or `setModel()`, which keep the profile in step — otherwise the edit is lost on the next profile switch or restart
- Image input (`ApiProfile.vision`): only 截图模式 needs it. `true` for preset models (`knownVision()`), set from the platform's `/models` list by `ModelField`, `false` once a screenshot is refused for it (`isImageInputRefused()` in `stream.ts` → `vision-unsupported`); absent means unknown and is allowed. A model change resets it. The model picker lists every platform model and only tags text-only ones; 截图模式's profile picker and its `cycleProfile` skip known text-only profiles
- The welcome dialog (`PrerequisitesChecker`) shows only until a key has ever been saved (`hasConfiguredApi`), so a request made with a blank profile key is reported by main as a `solution-error` instead
- Model ↔ API Base URL linkage lives in the renderer (`lib/providers.ts`): each platform spells the same model differently (`deepseek-flash` vs `deepseek/deepseek-v4.1-flash`), so the picker lists the selected platform's spelling and `setApiBaseURL()` translates the model on switch (else restores the one last used with that URL, else the platform default). Change the API Base URL through `changeApiBaseURL()`, not `updateSetting`, so the model follows and the user gets an undo toast. Preset models must accept image input (`knownVision()` relies on it)
- System prompts are maintained in the renderer settings store (`PRESET_SCENE_PROMPTS` in `lib/store/settings.ts`) as "prompt scenes". Each scene belongs to one mode (`mode`, absent = 截图模式) and each mode has its own active scene; their prompts are synced to main as `customPrompt` (截图模式) and `conversationPrompt` (对话模式)
- Preset scenes can be deleted too (at least one scene per mode always remains). `merge` rebuilds the presets on every load so new ones reach existing users, so a deleted preset's id goes into `removedPresetSceneIds` and is skipped; 「恢复预设场景」 (`restorePresetScenes(mode)`) brings back that mode's presets with default prompts
- An emptied scene prompt, preset or not, is saved as empty and sends no prompt (the 资料库 block still goes); 「恢复默认」 is the only way back to a preset's default, nothing refills it on load
- The system prompt is read per request, so switching scenes (`cycleScene` shortcut / toolbar) applies from the next request and keeps `conversationMessages`: a new screenshot starts a new conversation anyway, and a follow-up after switching needs what it follows up on. An answer already streaming keeps its prompt. The header shows `scene · model`, since a shortcut or a toolbar hover can switch it unnoticed
- Streaming functions: `getSolutionStream` (first screenshot), `getFollowUpStream` (follow-up), `getGeneralStream` (multi-screenshot), all run through `runAnswer()` in `shortcuts.ts`; `getHintStream` (对话模式, see below)
- 「关闭思考」 (`disableThinking`, per profile, off by default): the SDK has no field for it and every platform spells it differently, so `createThinkingOffFetch()` in `thinking.ts` wraps `fetch` and merges the fields into the request body — OpenRouter `reasoning: { enabled: false }`, OpenAI host or a `gpt-`/`o<n>` model name `reasoning_effort: 'none'`, everyone else both `thinking: { type: 'disabled' }` and `enable_thinking: false`. OpenAI rejects any unknown field, and thinking-only models reject the switch, so a 400/422 whose body mentions thinking/reasoning is resent without the fields and that base URL + model is remembered for the session. The switch never makes a request fail; at worst it costs one extra round trip
- Conversation history (`conversationMessages`) is maintained in `shortcuts.ts` as `ModelMessage[]`
- Reasoning: `ai.ts` turns `fullStream` into `StreamChunk`s tagged `reasoning` or `text` (`stream.ts`); only the text goes into `conversationMessages`. 截图模式 shows it per request: `clearSolution()` opens round 0, each appended screenshot / follow-up sends `reasoning-round-start` after its separator, and each round (`reasoningRounds`, with the answer length when it began as `textStart`) renders its block above its own slice of the answer — three streaming lines, folded once the answer starts. Both modes render it with `MarkdownRenderer compact` (OpenAI's summaries open with a `**title**`), whose whole-line grid in `base.css` keeps those three lines whole. 对话模式 keeps it on the card (`HintCard.reasoning`) and shows it once the card is published, not per chunk
- When an answer finishes naturally (not stopped, not failed), `handleGeneratedCode()` in `save-code.ts` copies its first code block to the clipboard and/or saves it as `<base><n>.<ext>` (extension from the fence language); both are opt-in and silent

### Capture Region

`captureRegion` crops every screenshot to one area of one screen, stored as fractions of that screen (`src/shared/capture-region.ts`) so a resolution or scaling change does not shift it:
- Three entry points — the settings button, the toolbar button and the `pickCaptureRegion` shortcut — all go through `pickRegion()` in `shortcuts.ts`, which applies the result to main's `settings` at once and sends `capture-region-picked` for the renderer store to persist
- `pickRegion()` soft-hides the main window through `whilePicking()` (unless it already was), then `region-picker.ts` opens one window per screen at `screen-saver` level above the main window and toolbar, each showing a frozen capture of its screen (content protection keeps the app out of it)
- Started from a shortcut or the toolbar, another app is active: the picker under the cursor takes focus (`app.focus({ steal: true })` on macOS) so Enter / Esc cannot land in, say, an exam page, and `acceptFirstMouse` lets the first click start a drag
- The picker is a page of its own (`src/renderer/picker.html` → `picker.tsx`, a second renderer input in `electron.vite.config.ts`), skipping `App`: a throwaway window must not sync settings or re-register shortcuts, and it loads React and the picker only, not the app's markdown / KaTeX / stores
- The pickers cover every screen, so any exit — Enter / Esc, closing one, a crashed or unresponsive renderer, a 5-minute timeout — closes them all and restores the main window
- The dimming around the selection is four plain panels: a `clip-path` hole or a huge `box-shadow` did not paint over the full-screen image
- A region whose screen is disconnected is kept but ignored until it comes back, so the whole screen is captured meanwhile
- 「框选识别」 (`snipScreenshot`) reuses the pickers for one screenshot (`purpose: 'screenshot'`), leaving `captureRegion` alone: releasing the drag ends the pick, and `pickScreenshot()` cuts the area from the frozen capture the user dragged on rather than capturing again (a menu may have closed when the picker took focus), scaled to the DIP size `takeScreenshot()` produces. It starts a new conversation like `takeScreenshot`, and shows the window if `hideOrShowMainWindow` had hidden it

### Conversation Mode (对话模式)

`/conversation` turns what the other side of a call says into hints, without screenshots. Main owns the conversation (`src/main/conversation.ts`); the page shows a copy, fetched with `conversation:get-snapshot` on mount and kept current by events, so visiting the settings mid-call loses nothing:
- Recognition runs with `purpose: 'conversation'` and `max_sentence_silence: conversationSilenceMs`; `transcription.ts` then hands every sentence revision to `conversation.ts` instead of accumulating 截图模式's text. Listening keeps running on the settings / help pages and stops when 截图模式's page mounts
- It is meant for system audio: in an online call that is only the other side, so a finished sentence can trigger a hint without speaker detection
- Automatic (`conversationHintMode: 'auto'`): a finished sentence with at least `conversationMinChars` meaningful characters asks for a hint at once, covering every sentence since the last hint. If the other side keeps talking (a new sentence reaches the minimum while the automatic hint streams) the hint is withdrawn (`waiting`) and rewritten into the same card when they finish — or when that sentence comes to nothing, or listening stops
- Shortcut / button (`generateHint`, either mode): brings the card being written or waiting up to date, else opens one for everything not yet hinted (a sentence still being spoken included), else rewrites the last hint with 「换一个角度」
- Several cards may stream at once. A card restarted by a newer request bumps its `generations` entry, so the stream it replaced never writes to it again
- The hint panel scrolls each new card to its top and does not follow the stream. The newest card keeps a panel's height of room under it (`last:min-h-full`), else a short one stops at the bottom edge showing one line. A finished card that runs past the bottom pages down once by itself (`revealRest()`), unless the user scrolled since: paging by hand is easy to spot on a call
- Each request sends the recent sentences as context (20 sentences / 1500 chars) plus the ones the hint is for; earlier hints are not sent back, so requests stay small
- The preset prompts ask for 「（无需回应）」 (`NO_REPLY`) when nothing needs an answer; the page dims those cards
- 「保存对话记录到本地」 (`conversationAutoSave`, off by default): `save-conversation.ts` writes the whole conversation as Markdown to `对话记录_<start time>.md` in `conversationSaveDir` (blank = Documents/Shiping), rewritten 1.5s after a change. A clear starts a new file, a pending save is flushed on clear and (synchronously) on `will-quit`, and turning it on mid-conversation saves what is there through `onSettingsChanged()`. Failed / withdrawn / 「（无需回应）」 hints are left out

### 资料库 (Knowledge)

Material the user wants the AI to draw on — a resume, prepared Q&A, notes — kept by main (`src/main/knowledge.ts`), not by the renderer store:
- Stored under `userData/knowledge/`: `index.json` for the list, `<id>.txt` per text, both cached in memory once read. Not in localStorage: a few documents would outgrow it, and settings are synced to main whole on every change
- Only the extracted text is kept, and the user can edit it (a PDF's layout often needs it); `sourcePath` is remembered for 「重新导入」, which overwrites those edits
- Each doc lists the modes it is sent with (`modes`, empty = kept but unused). `getKnowledgePrompt(mode)` wraps them in `<资料 name="…">` blocks with the rules for using them, and `getSystemPrompt()` in `ai.ts` puts that **before** the scene prompt: a prefix stable across requests and scene switches is what platforms cache, and the scene's format rules end up closer to the question
- Everything is sent in full with every request. `KNOWLEDGE_CHAR_LIMIT` (30,000 chars per mode) only drives a warning in the settings page; a request that still overflows the model is explained by `extractErrorMessage()`
- Parsers (`unpdf`, `mammoth`) are loaded with `import()` on first use. PDF text is passed through NFKC for the Kangxi radical look-alikes (「⼩」 for 「小」) some fonts map to
- The settings section is also a drop zone (`webUtils.getPathForFile`, exposed as `getPathForFile`); while it is mounted, a file dropped elsewhere in the window is swallowed instead of replacing the app

### Stream Abort Pattern

- `StreamContext` with `AbortController` and `reason` (`'user'` | `'new-request'`)
- New requests automatically abort previous streams. Only one answer ever streams: `beginStream()` aborts the current one and tracks the new one, and is called after any awaited capture — a stream started during the capture would otherwise go untracked, unstoppable, and write into the same answer
- A capture takes up to a second and Electron's `getSources` hands every concurrent call the same capture, so each screenshot request takes a `screenshotRequestId` and drops out after the capture unless it is still the newest
- User can manually stop via shortcut or UI button (`stopAnswer()`), which also drops a screenshot still being captured
- Abort reason determines which IPC event to send (`solution-stopped` for user, silent for new-request)

### Real-time Speech Transcription

- Uses DashScope (Alibaba Cloud) Fun-ASR real-time ASR via WebSocket (`src/main/transcription.ts`)
- Requires a separate `dashscopeApiKey` configured in settings
- Audio is captured in the renderer via `getDisplayMedia()` (system audio), downsampled to 16kHz PCM, and streamed to main process via IPC
- `TranscriptionBar` is absolute-positioned at the top of the coder page, shows up to 3 lines with auto-scroll
- On screenshot (`takeScreenshot` / `appendScreenshot`), accumulated transcription text is automatically attached to the AI prompt, then cleared
- `clearTranscription` shortcut clears text without submitting to AI
- Transcription shortcuts are disabled in settings UI when `dashscopeApiKey` is not configured
- In 对话模式 the same shortcuts start / stop listening and clear the whole conversation

### Shortcut System

- Global shortcuts registered via Electron's `globalShortcut` API
- Renderer stores shortcut config in Zustand (persisted); sends to main on init
- A key is held only while its action has something to do, since a held key never reaches the app in front: `syncShortcuts()` takes the keys `isShortcutLive()` allows and releases the rest. Each action's scope is in `SHORTCUT_SCOPES` (its page, whether it is meant for the hidden window, whether it acts on the window itself, whether it needs the DashScope key); a new action needs an entry. Hidden, only `hideOrShowMainWindow` and `snipScreenshot` stay, plus the non-window actions while phones watch (手机同步). Nothing is held while the settings page records a key (`setShortcutRecording`)
- Call `syncShortcuts()` wherever the window is shown or hidden: the main window's `show` / `hide` events did not fire on macOS. A page change, a DashScope key change and phones coming or going (`onMobileViewersChanged()`) re-sync on their own
- An empty key is one the user cleared (Backspace while recording); `merge` keeps it cleared. `getShortcuts` reports a key another app holds as `failed`, trying an untried key briefly; macOS lets two apps hold the same key, so there it only catches the system's own
- On Windows, `Alt`-based shortcuts also register `Ctrl+Alt` variant for compatibility
- On Windows a held shortcut repeats at the keyboard's auto-repeat rate (Chromium registers it without `MOD_NOREPEAT`). `isKeyRepeat()` drops a press within 600ms of the previous one of the same action, so holding the keys fires once; only `REPEATABLE_ACTIONS` (move, page, opacity) keep repeating
- Shortcut actions are string-keyed callbacks in `shortcuts.ts`
- Default shortcuts use `platformAlt` (`Alt` on macOS, `CommandOrControl` on Windows: in many Windows apps pressing Alt alone activates the menu bar). `snipScreenshot` is `Ctrl+Alt+S` on Windows, not `Ctrl+Shift+S` (另存为 nearly everywhere), since it stays held while the window is hidden
- New actions also need a label in `settings/CustomShortcuts.tsx` and a description in `help/Shortcuts.tsx`
- Categories: `Window Management`, `Screenshot` (截图模式 only), `Conversation` (对话模式 only), `AI` (acts on whichever mode is on screen: stop, profile, scene, transcription), `Navigation`, `Window Movement`. Only the key of a stored binding is the user's; `merge` takes the category from the code
- Actions acting on "the current mode" check `inModePage()` (`state.ts`) and are answered by `useModePage()` on either page

### 手机同步 (Mobile Sync)

What the mode pages show, mirrored read-only to a phone's browser (`src/main/mobile-sync.ts`). The app is the only source of truth; phones only display:
- Main pushes the **whole** state (`MobileState` in `src/shared/mobile.ts`) as one JSON message, at most every 200ms, and the relay keeps the last one for phones that open later. No diffs, no history: a phone that reconnects just gets the current state. `v` is the format version for when the page and the app drift apart. Since the whole state is resent, it must stay under the relay's `MAX_PAYLOAD` (1 MiB): 截图模式's answer goes out as its last `MOBILE_TEXT_LIMIT` characters, and the relay client drops a frame that is still too big instead of sending it (which would close with 1009 and resend it on every reconnect)
- Parts of the state are `registerMobileSource()`d by their owners — 截图模式's answer in `shortcuts.ts` (`mobileAnswer`, appended in `sendAnswerChunk()`), 对话模式's last cards and sentences in `conversation.ts` — which call `markMobileDirty()` on change. A new part is a new source key plus its rendering in `relay/public/app.js`. `mode` follows the page on screen (the page-change handler marks dirty) and keeps the last mode on the settings / help pages
- The page shortcuts (`pageUp` / `pageDown`) page the phones too, for a phone read without being touched: `pageMobile()` moves `paging`, a count in the state, and the page scrolls the tab in view by how much it changed since the last message. Presses within one push add up; the first state after (re)connecting or a `host` message only sets the baseline, so nothing is replayed and a restarted app counting from 0 pages nothing
- `relay/relay.mjs` is the one implementation of the protocol, used twice: by `relay/server.mjs` on the user's server, where the app connects to `/host` as a client (`Authorization: Bearer RELAY_KEY`), and in-process by main for 局域网 on port 8790, where `publish()` stands in for the host. The phone page in `relay/public/` is inlined into main with `?raw`, so both serve the same files
- One key per path (`mobileLanKey`, generated; `mobileRelayKey`, the server's `RELAY_KEY`). Phones never get the key, only `deriveViewerToken(key)` (HMAC) in the link's fragment (`#t=`, never sent in requests for the page): it can watch but not push. `/check` tells the page a revoked link (401) or a full house (503, `maxViewers`: 10 by default, `MAX_VIEWERS` on the server; it keeps retrying) from a network failure; the settings page shows the limit next to the viewer count. A second app connecting with the same key takes over and the first is closed with 4000, which it does not retry
- The QR code is shown only in the settings page, which content protection keeps off a shared screen
- The phone page's 屏幕常亮 button keeps the phone from dimming and locking (a locked phone also drops the connection). It uses the Screen Wake Lock API where offered (HTTPS only, so the relay), else plays a 2.4 KB invisible clip inlined in `app.js` (the LAN page; `media-src data:` in the relay's CSP). The clip has a silent track and jumps back instead of `loop`: WebKit keeps the screen on only for media with sound that does not loop. The choice is kept on the phone; what cannot be retaken without a tap (a reopened page) comes back with the next tap anywhere. Desktop shortcuts never count as activity on the phone
- Settings changes are applied 600ms after typing stops (`reconcile()`); a failed LAN start (port taken) is retried with the next change. The relay client reconnects with backoff (1s → 30s) and drops a connection silent for 60s; a 401 is not retried
- `relay/` has its own `package.json` and `node_modules` and is excluded from the packaged app (`electron-builder.yml`); main bundles `ws` from the root dependencies

### Update Notice

`src/main/auto-updater.ts` checks at startup and every 6 hours, and reports a newer release with `update-status`. It is never a native dialog or a system notification: those are drawn outside content protection, so one popping up mid-interview would show on the shared screen
- Shown inside the main window only: a 「有新版本」 badge after the version in `AppHeader`, leading to the help page, where `UpdateNotice` holds the details and the button
- Windows: electron-updater with `autoDownload = false`. The user starts the download and the restart; a finished download also installs on quit (`autoInstallOnAppQuit`)
- macOS: no Apple signature (see macOS Signing), and Squirrel.Mac was never tried with it. Main requests github.com/…/releases/latest/download/latest.yml with `net.request` (system proxy) and reads the tag from where it redirects (`…/releases/download/<tag>/…`, whether the release has the file or not), following the extra hop a renamed repository adds, and the card links to the release page. It then downloads the file without reading it, so `latest.yml`'s download count counts the checks of both platforms; v3.4.0 and earlier read `releases/latest` instead and are not counted. v3.3.0 stops at the rename's hop, so its macOS users get no notice once the repository is renamed. Not the REST API: its 60 unauthenticated requests an hour per IP run out on a shared proxy exit
- Both follow Latest only, never a pre-release: a release reaches users once it is promoted to Latest. A failed check stays silent

### Legacy Name

The app was renamed from 截屏解题助手 (`interview-coder-cn`) to 识屏 (`shiping`) in 2026-10. A few things keep the old name, because changing them would cost every existing user something:
- `appId` (`com.electron.app`): macOS TCC grants and the Windows installer's upgrade-in-place (its GUID) both key on it
- The macOS signing certificate's name (see macOS Signing): a new certificate means a new grant
- The zustand `persist` keys `interview-coder-settings` / `interview-coder-shortcuts`: localStorage is looked up by them
- Electron names userData after the package (`app.name`), so `legacy-name.ts` renames the old `interview-coder-cn` folder on the first start under the new name, before anything opens it; if the rename fails, the old folder is used in place. It also deletes the old Windows updater cache (`%LOCALAPPDATA%/interview-coder-cn-updater`, which keeps a whole installer)
- A Windows install upgraded in place stays in its old folder (`Programs/interview-coder-cn`): the NSIS installer reuses the registered `InstallLocation`
- GitHub redirects the old repository URL, which keeps old clients' update checks working, as long as no new repository takes the old name

### macOS Signing

`build/after-pack.mjs` signs the macOS app with a self-signed certificate (`Interview Coder CN`, named before the rename; SHA-1 in `CERT_SHA1`). electron-builder's own signing is off (`mac.identity: null`): it only takes a certificate macOS trusts:
- The signature is what makes system audio work, not only a Gatekeeper matter. Without one bound to the bundle (Electron's linker signature only), TCC identifies the app by its executable path when a helper asks on its behalf, so the audio service is refused the screen capture behind system audio while screenshots, taken in the main process, work (#104)
- The certificate keeps the designated requirement (`identifier "com.electron.app" and certificate leaf = H"…"`) the same across releases, so a user grants 屏幕与系统音频录制 once. An ad-hoc signature would tie it to each build's hash. A new certificate or a new `appId` makes every user grant it again
- CI imports the certificate from the `MAC_CERT_P12_BASE64` / `MAC_CERT_PASSWORD` secrets into a temporary keychain (`MAC_SIGN_KEYCHAIN`), which must be on the user search list: codesign on macOS 26 finds no identity elsewhere, `--keychain` or not. The build fails without the certificate; a local build without it is signed ad-hoc
- To see what TCC decides: `log stream --predicate 'subsystem == "com.apple.TCC" OR process == "replayd"'`, then `AUTHREQ_SUBJECT` / `AUTHREQ_RESULT` for the process in question

### Tray Icon

`src/main/tray.ts`: the macOS menu bar icon and the Windows notification-area icon, there mainly for 框选识别, so the app can stay hidden and still be used with the mouse alone:
- A click runs `snipScreenshot`, exactly as the shortcut does (`runShortcutAction()`). Off 截图模式's page the shortcut does nothing, so the click opens the menu instead, where the item says why it is disabled
- Right-click (and Control-click on macOS) opens the menu, rebuilt on every opening: 框选识别, 显示 / 隐藏窗口 (`hideOrShowMainWindow`; a soft-hidden window counts as hidden, `isMainWindowShown()`), 设置… (reveals the window and sends `open-settings`; the renderer owns the routes), 退出识屏. Items show their registered shortcut (`registeredShortcut()`, `registerAccelerator: false`)
- Shown by default, hidden with `hideTrayIcon` (「界面与隐私」), applied live from the settings sync. The persisted value lives in the renderer, so like the Dock icon (main starts it hidden, see `index.ts`) the tray is only created by the first sync: it never flashes for someone who hides it
- The header has both 隐藏 (–, `hideMainWindow`) and 退出 (✕, `window.close()`), so each button always means one thing. Closing the window quits on both platforms (`window-all-closed` in `index.ts`): every tray action needs that window, so the tray must not outlive it
- After 框选识别 the window takes the keyboard (the picker had it) and starts a snip session (`snip-session`): Esc hides the window. It works exactly while the status bar shows the 「Esc 隐藏窗口」 hint after 「新开对话」, in the same style: the answer finished and the shortcut hints shown (`hideShortcutHints` off), and not with the follow-up dialog open, where Esc closes the dialog. The session ends when the window loses the keyboard, is hidden, or leaves 截图模式's page, so Esc never acts on a window the user is not using. Every other way of showing the window keeps the overlay's rule of not taking focus, and Esc stays with the app in front
- `hideMainWindow()` hands the keyboard back when the window had it: `app.hide()` on macOS (the window is hidden already; a later `showInactive()` still does not activate the app), `blur()` on Windows. A window without it changes nothing
- No tooltip: it is drawn outside content protection. The icon itself is not covered either, so it shows when the whole screen is shared; the setting's note says so
- macOS uses a template image (`resources/trayTemplate.png` + `@2x`, drawn from `build/tray.svg`), tinted by the system for a light or dark menu bar; Windows uses `resources/tray.ico`, the 16–64 px entries of `build/icon.ico`

### Mouse Click-through

- `state.ignoreMouse` is the user's preference; `applyIgnoreMouse()` in `shortcuts.ts` is the only place that applies it to the window. Go through `setIgnoreMouse()` / `applyIgnoreMouse()`, never `setIgnoreMouseEvents()` directly
- It is suspended while the settings page is up (`inSettingsPage`): the switch that turns it off lives there, so applying it would trap the user. The preference is kept and applied on the way out
- Independent of the overlay toolbar, and the shortcut works on every page as an escape hatch

### UI Component Patterns

- shadcn/ui components in `src/renderer/src/components/ui/` — do NOT edit these directly, use the shadcn CLI to add/update
- `cn()` utility (clsx + tailwind-merge) for conditional class merging
- `getCloneableFields()` strips functions from store state before sending over IPC
- Platform-aware shortcut display via `ShortcutRenderer` (⌘, ⌥, ⇧ on Mac; Ctrl, Alt, Shift on Windows)

## Development

### Commands

```bash
npm install          # Install dependencies
npm run dev          # Start in dev mode (electron-vite dev)
npm run build        # Typecheck + build (electron-vite build)
npm test             # Unit tests (node:test, tests/*.test.cjs)
npm run test:proxy   # Proxy checks against the real Electron network stack
npm run build:mac    # Build macOS distributable
npm run build:win    # Build Windows distributable
npm run typecheck    # Run TypeScript type checking (node + web)
npm run lint         # Run ESLint
npm run format       # Run Prettier
```

### Configuration

The `.env` file at project root configures the AI provider:

```env
API_BASE_URL="https://openrouter.ai/api/v1"  # OpenAI-compatible API endpoint
API_KEY="sk-..."                               # API key
MODEL="gpt-5-mini"                             # Optional: override default model
```

These are read by dotenv in the main process and merged with renderer-side settings (renderer settings take priority when set).

### Path Aliases

- `@renderer/*` and `@/*` both resolve to `src/renderer/src/*`
- Configured in `tsconfig.web.json` and `electron.vite.config.ts`

### Code Style

- Prettier: single quotes, no semicolons, 100 char print width, no trailing commas
- ESLint: TypeScript + React + React Hooks + React Refresh rules
- UI text and user-facing strings are in **Chinese** (中文)
- Code comments and variable names are in **English**

## Important Notes for AI Agents

1. **Three TypeScript configs**: `tsconfig.node.json` (main + preload), `tsconfig.web.json` (renderer). The root `tsconfig.json` is a project references file only.

2. **System prompts live in the renderer**: All preset scene prompts are defined in `src/renderer/src/lib/store/settings.ts` (`PRESET_SCENE_PROMPTS`). The main process only consumes the synced `customPrompt` / `conversationPrompt` and has no built-in prompt of its own.

3. **`global.mainWindow`**: The main window reference is stored as a global variable, declared in `src/main/index.d.ts`.

4. **Settings flow**: `.env` → main process `settings` object → renderer reads on mount via IPC → renderer persists to localStorage via Zustand. Renderer-side changes are sent back to main via `updateAppSettings`.

5. **No shared types directory**: Main process types (`AppSettings`, `AppState`) are imported directly by the preload script from `../main/settings` and `../main/state`. This works because preload shares the Node.js tsconfig. Runtime code both sides need goes in `src/shared/` (included by both tsconfigs, imported by relative path) and must stay free of Electron, DOM and Node APIs.

6. **Streaming orchestration is in `shortcuts.ts`**: Despite the filename, this 850+ line file is the central orchestrator for both global shortcuts AND 截图模式's AI streaming. It manages conversation history, abort controllers, and IPC communication for that workflow; 对话模式's lives in `conversation.ts`.

7. **Startup mode**: `main.tsx` sets the hash to `#/conversation` before rendering when `lastMode` says so; the back buttons of the settings / help pages return to `lastMode` too.

8. **Window movement**: The window can be moved via keyboard shortcuts in 200px steps (up/down/left/right), and resized by dragging its edges (see Window Resizing).

9. **macOS has no auto-update**: `publish: null` in electron-builder.yml for the mac target, since the build has no Apple signature (see macOS Signing). It only gets the in-window notice linking to the release page (see Update Notice).

10. **macOS and Windows only**: Linux is not a supported or built target.

11. **Prompt files are Prettier-ignored**: `src/renderer/src/lib/store/prompts/` is listed in `.prettierignore` — Prettier rewrites the literal ``` fences inside those prompts, which changes what the model is told.
