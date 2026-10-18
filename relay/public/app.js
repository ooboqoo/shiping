/* global marked, hljs */
'use strict'

/**
 * The phone's view of the desktop app. It shows the latest state the app
 * published (see `MobileState` in the app's src/shared/mobile.ts) and nothing
 * else: every message replaces the whole picture, so a reconnect needs no
 * catching up.
 */
;(() => {
  /** Must match NO_REPLY in the app's src/shared/conversation.ts */
  const NO_REPLY = '（无需回应）'
  const RETRY_MAX = 10_000
  /** Within this many px of the bottom, a growing page keeps the bottom in view */
  const STICK_SLACK = 80
  /** What a page keeps of the one before, in px, so the eye finds its line */
  const PAGE_OVERLAP = 48
  const FONT_SIZES = [
    { id: '', label: '标准' },
    { id: 'large', label: '大' },
    { id: 'small', label: '小' }
  ]

  // The token rides in the fragment, which never reaches a server or a log.
  // Kept for a reopened tab or a home-screen icon that lost the fragment
  const token =
    new URLSearchParams(location.hash.slice(1)).get('t') || localStorage.getItem('ic-token') || ''
  if (token) localStorage.setItem('ic-token', token)

  const $ = (id) => document.getElementById(id)
  const root = document.documentElement
  const statusEl = $('status')
  const bannerEl = $('banner')
  const answerEl = $('answer')
  const answerMetaEl = $('answer-meta')
  const answerErrorEl = $('answer-error')
  const hintsEl = $('hints')
  const listenMetaEl = $('listen-meta')
  const listenErrorEl = $('listen-error')
  const jumpEl = $('jump')
  const toastEl = $('toast')
  const tabs = [...document.querySelectorAll('[data-tab]')]

  const escapeHtml = (text) =>
    String(text).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    )

  function highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        // shown plain
      }
    }
    return escapeHtml(code)
  }

  marked.use({
    gfm: true,
    renderer: {
      // Raw HTML in an answer is shown as text, the way the desktop shows it
      html: ({ text }) => escapeHtml(text),
      code: ({ text, lang }) => {
        const language = (lang || '').trim().split(/\s+/)[0].toLowerCase()
        return `<div class="code-block"><div class="code-head"><span>${
          escapeHtml(language) || '代码'
        }</span><button type="button" class="wrap-toggle">自动换行</button></div><pre><code class="hljs">${highlight(text, language)}</code></pre></div>`
      }
    }
  })
  const markdown = (text) => marked.parse(text || '')

  // ---- Chrome: status, banner, toast, font size ----

  function setStatus(kind, text) {
    statusEl.className = `status ${kind}`
    statusEl.lastElementChild.textContent = text
  }

  function setBanner(text, kind = '') {
    bannerEl.hidden = !text
    bannerEl.className = kind
    bannerEl.textContent = text || ''
  }

  let toastTimer = null
  function toast(text, ms = 1200) {
    toastEl.textContent = text
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastEl.hidden = true), ms)
  }

  let fontIndex = Math.max(
    0,
    FONT_SIZES.findIndex((size) => size.id === (localStorage.getItem('ic-font') || ''))
  )
  function applyFont() {
    const { id } = FONT_SIZES[fontIndex]
    if (id) root.dataset.font = id
    else delete root.dataset.font
    localStorage.setItem('ic-font', id)
  }
  applyFont()
  $('font-size').addEventListener('click', () => {
    fontIndex = (fontIndex + 1) % FONT_SIZES.length
    applyFont()
    toast(`字号：${FONT_SIZES[fontIndex].label}`)
  })

  // Code wraps by default: a phone is too narrow to scroll every line sideways.
  // One choice for every block, kept on the phone
  let codeWrap = localStorage.getItem('ic-code-wrap') !== 'off'
  function applyCodeWrap() {
    if (codeWrap) delete root.dataset.codeWrap
    else root.dataset.codeWrap = 'off'
    localStorage.setItem('ic-code-wrap', codeWrap ? 'on' : 'off')
  }
  applyCodeWrap()
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('.wrap-toggle')
    if (!button) return
    // Every block above changes height too: keep the tapped one where it was
    const block = button.closest('.code-block')
    const before = block.getBoundingClientRect().top
    codeWrap = !codeWrap
    applyCodeWrap()
    scrollBy(0, block.getBoundingClientRect().top - before)
    toast(codeWrap ? '代码：自动换行' : '代码：横向滚动')
  })

  // ---- Keeping the screen on ----

  // A phone read on a stand dims and locks by itself, and a locked phone drops
  // the connection too. The system's wake lock is only offered over HTTPS, so
  // the LAN page (plain http) plays a tiny invisible clip instead, which phones
  // keep the screen on for. Either way it is the lit screen that costs battery,
  // not the clip
  /** Black 64×64 at 2 fps with a silent track, 3 s (2.4 KB) */
  const AWAKE_CLIP =
    'data:video/mp4;base64,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'
  const AWAKE_MODES = { system: '系统', video: '视频' }
  const canLockSystem = window.isSecureContext && 'wakeLock' in navigator
  const awakeEl = $('awake')
  /** The user's choice, kept on the phone */
  let awakeWanted = localStorage.getItem('ic-awake') === 'on'
  /** What holds the screen on right now: 'system', 'video' or null */
  let awakeMode = null
  let awakeBusy = false
  let wakeLock = null
  let awakeVideo = null

  function showAwake() {
    const on = awakeMode !== null
    awakeEl.classList.toggle('on', on)
    awakeEl.classList.toggle('pending', awakeWanted && !on)
    awakeEl.setAttribute('aria-pressed', String(on))
    awakeEl.setAttribute('aria-label', on ? `屏幕常亮（${AWAKE_MODES[awakeMode]}）` : '屏幕常亮')
  }

  async function lockSystem() {
    try {
      const sentinel = await navigator.wakeLock.request('screen')
      wakeLock = sentinel
      // The browser lets go whenever the page is hidden; it is retaken on return
      sentinel.addEventListener('release', () => {
        if (wakeLock !== sentinel) return
        wakeLock = null
        awakeMode = null
        showAwake()
      })
      return true
    } catch {
      // Refused (battery saver, a policy): the clip may still do
      return false
    }
  }

  function playClip() {
    if (!awakeVideo) {
      const video = document.createElement('video')
      video.id = 'awake-video'
      video.src = AWAKE_CLIP
      video.setAttribute('playsinline', '')
      video.setAttribute('aria-hidden', 'true')
      // WebKit keeps the screen on only for media with sound, and never for a
      // looping one: hence the silent track, and a jump back instead of `loop`
      video.addEventListener('timeupdate', () => {
        if (video.currentTime > 1.5) video.currentTime = 0
      })
      document.body.append(video)
      awakeVideo = video
    }
    return awakeVideo.play().then(
      () => true,
      () => false
    )
  }

  function dropAwake() {
    awakeMode = null
    const sentinel = wakeLock
    wakeLock = null
    sentinel?.release().catch(() => {})
    awakeVideo?.pause()
  }

  /** Hold the screen on by the first means that works; resolves to the mode or null */
  async function takeAwake() {
    if (awakeMode || awakeBusy || document.visibilityState !== 'visible') return awakeMode
    awakeBusy = true
    try {
      // Without a system lock to try, play() runs before any await, while the
      // tap still counts as one: older Safari only plays from within it
      let mode = null
      if (canLockSystem && (await lockSystem())) mode = 'system'
      else if (await playClip()) mode = 'video'
      awakeMode = mode
      // Turned off while it was being taken
      if (!awakeWanted) dropAwake()
    } finally {
      awakeBusy = false
      showAwake()
    }
    return awakeMode
  }

  awakeEl.addEventListener('click', async () => {
    if (awakeBusy) return
    if (awakeMode) {
      awakeWanted = false
      localStorage.setItem('ic-awake', 'off')
      dropAwake()
      showAwake()
      toast('屏幕常亮：关闭')
      return
    }
    awakeWanted = true
    const mode = await takeAwake()
    awakeWanted = mode !== null
    localStorage.setItem('ic-awake', awakeWanted ? 'on' : 'off')
    showAwake()
    // Which way it went, so a browser can be checked by trying it once
    toast(mode ? `屏幕常亮：已开启（${AWAKE_MODES[mode]}）` : '这个浏览器无法保持常亮', 2400)
  })

  // What could not be retaken without a tap (a reopened page, a clip the
  // browser would not resume) comes back with the next tap anywhere
  function resumeOnTap(event) {
    if (!awakeWanted || awakeMode || event.target.closest?.('#awake')) return
    takeAwake().then((mode) => mode && toast(`屏幕常亮：已恢复（${AWAKE_MODES[mode]}）`))
  }
  document.addEventListener('touchend', resumeOnTap, { passive: true })
  document.addEventListener('click', resumeOnTap)

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (awakeWanted) takeAwake()
    } else if (awakeMode === 'video') {
      // Hidden, the clip holds nothing on and would only keep playing
      awakeVideo.pause()
      awakeMode = null
      showAwake()
    }
  })

  showAwake()
  if (awakeWanted) takeAwake()

  // ---- Tabs ----

  let state = null
  let tab = 'screenshot'
  /** The desktop's mode at the last message: the view follows it when it changes */
  let desktopMode = null
  /** Where each tab was scrolled to; null scrolls to the bottom (the newest card) */
  const tabScroll = { screenshot: 0, conversation: null }
  /** What each tab last rendered (and what it last showed while in view) */
  const rendered = { screenshot: '', conversation: '' }
  const seen = { screenshot: '', conversation: '' }

  function showTab(next) {
    if (next === tab) return
    tabScroll[tab] = atBottom() && tab === 'conversation' ? null : scrollY
    tab = next
    pageTarget = null
    for (const button of tabs) button.classList.toggle('active', button.dataset.tab === next)
    $('screenshot').hidden = next !== 'screenshot'
    $('conversation').hidden = next !== 'conversation'
    jumpEl.hidden = true
    renderNow()
    const saved = tabScroll[next]
    scrollTo(0, saved === null ? root.scrollHeight : saved)
  }

  for (const button of tabs) button.addEventListener('click', () => showTab(button.dataset.tab))

  /** A dot on the tab out of view whose content changed since it was last looked at */
  function markUnseen() {
    for (const button of tabs) {
      const name = button.dataset.tab
      if (name === tab) seen[name] = rendered[name]
      button.classList.toggle('has-unseen', name !== tab && rendered[name] !== seen[name])
    }
  }

  // ---- Rendering ----

  const CHIPS = {
    streaming: '<span class="chip streaming"><i class="spinner"></i>生成中</span>',
    waiting: '<span class="chip waiting">对方还在说，说完再写</span>',
    done: '<span class="chip done">已完成</span>',
    stopped: '<span class="chip">已停止</span>',
    error: '<span class="chip error">出错</span>'
  }

  const SKELETON = '<div class="skeleton"><div></div><div></div><div></div></div>'

  /** Replace `el`'s content, keeping code blocks scrolled sideways where they were */
  function replaceHtml(el, html) {
    const offsets = [...el.querySelectorAll('pre')].map((pre) => pre.scrollLeft)
    el.innerHTML = html
    el.querySelectorAll('pre').forEach((pre, i) => {
      if (offsets[i]) pre.scrollLeft = offsets[i]
    })
  }

  function renderScreenshot(answer) {
    if (!answer || answer.status === 'idle') {
      answerMetaEl.innerHTML = ''
      answerErrorEl.hidden = true
      answerEl.className = 'markdown'
      answerEl.innerHTML = $('empty-screenshot').innerHTML
      return
    }
    const chips = [CHIPS[answer.status] || '']
    if (answer.screenshots > 1)
      chips.push(`<span class="chip">共 ${answer.screenshots} 张截图</span>`)
    answerMetaEl.innerHTML = chips.join('')
    answerErrorEl.hidden = !answer.error
    answerErrorEl.textContent = answer.error || ''
    const streaming = answer.status === 'streaming'
    answerEl.className = `markdown${streaming && answer.text ? ' streaming' : ''}`
    replaceHtml(answerEl, answer.text ? markdown(answer.text) : streaming ? SKELETON : '')
  }

  function renderSaid(utterances) {
    if (utterances.length === 0) return ''
    const lines = utterances.map((u) =>
      u.final
        ? `<p>${escapeHtml(u.text)}</p>`
        : `<p class="live">${escapeHtml(u.text)}<span class="typing"><i></i><i></i><i></i></span></p>`
    )
    return `<div class="said"><div class="who">对方</div><div class="bubble">${lines.join('')}</div></div>`
  }

  function renderHint(card) {
    if (card.status === 'done' && card.text.trim() === NO_REPLY) {
      return '<div class="hint-card">无需回应</div>'
    }
    const streaming = card.status === 'streaming'
    const body = card.text
      ? `<div class="markdown${streaming ? ' streaming' : ''}">${markdown(card.text)}</div>`
      : streaming
        ? SKELETON
        : ''
    const error = card.error ? `<div class="error-box">${escapeHtml(card.error)}</div>` : ''
    return `<div class="hint-card">
      <div class="hint-head"><span>提示</span>${card.status === 'done' ? '' : CHIPS[card.status] || ''}</div>
      ${body}${error}
    </div>`
  }

  function renderConversation(conversation) {
    renderListening(conversation)
    const utterances = conversation?.utterances || []
    const hints = conversation?.hints || []
    if (utterances.length === 0 && hints.length === 0) {
      hintsEl.innerHTML = $('empty-conversation').innerHTML
      return
    }
    const between = (from, to) => utterances.filter((u) => u.id >= from && u.id <= to)
    // What the other side said since the last hint
    const hintedUpTo = hints.reduce((max, card) => Math.max(max, card.toId), 0)
    const pending = utterances.filter((u) => u.id > hintedUpTo)
    const html = hints.map((card, i) => {
      const classes = ['turn']
      if (i === hints.length - 1) classes.push('latest')
      if (card.status === 'done' && card.text.trim() === NO_REPLY) classes.push('no-reply')
      return `<div class="${classes.join(' ')}">${renderSaid(between(card.fromId, card.toId))}${renderHint(card)}</div>`
    })
    if (pending.length > 0) html.push(`<div class="turn">${renderSaid(pending)}</div>`)
    replaceHtml(hintsEl, html.join(''))
  }

  // Whether the app hears the other side; absent from an app older than this page
  function renderListening(conversation) {
    const listening = conversation?.listening
    listenMetaEl.innerHTML =
      listening === undefined
        ? ''
        : listening
          ? '<span class="chip done"><i class="dot"></i>监听中</span>'
          : '<span class="chip">未在监听</span>'
    const error = !listening && conversation?.listenError
    listenErrorEl.hidden = !error
    listenErrorEl.textContent = error ? `监听出错：${error}` : ''
  }

  const maxScroll = () => root.scrollHeight - innerHeight
  // Mid-page the view is wherever the page is headed: a hint streaming in must
  // not pull a page up that has just left the bottom back down
  const atBottom = () => (pageTarget ?? scrollY) >= maxScroll() - STICK_SLACK

  // ---- Paging from the desktop ----

  // The desktop's page shortcut pages the phone too (`paging` in MobileState),
  // for a phone that is read without being touched
  /** The desktop's count at the last message; null until this connection's first */
  let lastPaging = null
  let pendingPages = 0
  /** Where the paging in progress is headed, so quick presses add up */
  let pageTarget = null
  let pageTimer = null

  function page(pages) {
    const step = Math.max(innerHeight - $('topbar').offsetHeight - PAGE_OVERLAP, 100)
    const from = pageTarget ?? scrollY
    pageTarget = Math.min(Math.max(from + pages * step, 0), Math.max(maxScroll(), 0))
    scrollTo({ top: pageTarget, behavior: 'smooth' })
    clearTimeout(pageTimer)
    pageTimer = setTimeout(() => (pageTarget = null), 800)
  }

  /** Render what changed; returns whether the tab in view did */
  function renderNow() {
    if (!state) return false
    let changed = false
    const answer = state.screenshot
    const answerKey = JSON.stringify(answer || null)
    if (answerKey !== rendered.screenshot) {
      rendered.screenshot = answerKey
      renderScreenshot(answer)
      changed ||= tab === 'screenshot'
    }
    const conversationKey = JSON.stringify(state.conversation || null)
    if (conversationKey !== rendered.conversation) {
      rendered.conversation = conversationKey
      renderConversation(state.conversation)
      changed ||= tab === 'conversation'
    }
    // What was there when the page opened is not news
    if (!seen.screenshot && !seen.conversation) Object.assign(seen, rendered)
    markUnseen()
    return changed
  }

  let renderQueued = false
  let answerId = null

  function render() {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(() => {
      renderQueued = false
      if (!state) return
      const wasAtBottom = atBottom()
      const id = state.screenshot?.id ?? null
      const newAnswer = id !== answerId
      answerId = id
      const changed = renderNow()
      if (tab === 'screenshot') {
        // A new screenshot is a new question: read it from the top
        if (newAnswer) {
          pageTarget = null
          scrollTo(0, 0)
        }
      } else if (changed) {
        // 对话模式 grows at the bottom, like a chat
        if (wasAtBottom) scrollTo(0, root.scrollHeight)
        else jumpEl.hidden = false
      }
      // After the content is in, so a page lands on what the desktop shows
      if (pendingPages) {
        page(pendingPages)
        pendingPages = 0
      }
    })
  }

  jumpEl.addEventListener('click', () => {
    jumpEl.hidden = true
    scrollTo({ top: root.scrollHeight, behavior: 'smooth' })
  })
  addEventListener(
    'scroll',
    () => {
      if (!jumpEl.hidden && atBottom()) jumpEl.hidden = true
    },
    { passive: true }
  )

  function onState(next) {
    state = next
    if (next.mode && next.mode !== desktopMode) {
      desktopMode = next.mode
      showTab(next.mode)
    }
    // An older app sends no `paging`
    if (typeof next.paging === 'number') {
      if (lastPaging !== null) pendingPages += next.paging - lastPaging
      lastPaging = next.paging
    }
    render()
  }

  // ---- Connection ----

  let socket = null
  let connecting = false
  let retryDelay = 1000
  let retryTimer = null
  let invalid = false

  function retryLater() {
    clearTimeout(retryTimer)
    retryTimer = setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX)
  }

  function giveUp(message) {
    invalid = true
    setStatus('invalid', '链接失效')
    setBanner(message, 'bad')
  }

  async function connect() {
    clearTimeout(retryTimer)
    if (socket || connecting || invalid) return
    if (!token) return giveUp('链接里没有访问令牌，请在电脑上「设置 → 手机同步」重新扫码')
    connecting = true
    setStatus('connecting', '连接中')
    try {
      // A refused WebSocket only reports that it closed; this tells an expired
      // QR code apart from a network that is down
      const check = await fetch(`check?t=${encodeURIComponent(token)}`, { cache: 'no-store' })
      if (check.status === 401) {
        return giveUp('二维码已失效（密钥已更换），请在电脑上「设置 → 手机同步」重新扫码')
      }
      // Full: keep trying, a phone that closes its page frees a place
      if (check.status === 503) {
        const { maxViewers } = await check.json().catch(() => ({}))
        setStatus('offline', '人数已满')
        setBanner(
          `同时在看的手机已满${maxViewers ? `（上限 ${maxViewers} 台）` : ''}，关掉其他手机上的页面后会自动连上`,
          'bad'
        )
        retryLater()
        return
      }
    } catch {
      setStatus('offline', '连不上')
      retryLater()
      return
    } finally {
      connecting = false
    }

    const url = new URL(`view?t=${encodeURIComponent(token)}`, location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.hash = ''
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => {
      retryDelay = 1000
    }
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === 'host') {
        // A restarted app counts from 0 again, and a state kept from before
        // a reconnect holds presses this page has already followed
        lastPaging = null
        if (message.online) {
          setStatus('online', '已连接')
          setBanner('')
        } else {
          setStatus('offline', '电脑离线')
          setBanner('电脑端已断开，下面是断开前的内容，重新连上后会自动更新')
        }
      } else if (message.type === 'state' && message.data) {
        onState(message.data)
      }
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      setStatus('offline', '重连中')
      retryLater()
    }
  }

  // A phone puts the page to sleep: reconnect the moment it is looked at again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket) {
      retryDelay = 1000
      connect()
    }
  })
  addEventListener('online', () => {
    if (!socket) connect()
  })

  connect()
})()
