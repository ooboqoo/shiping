'use strict'
const savedChatPage = LibraryUI.readPageState()
const chatChoice = new Map(Object.entries(savedChatPage.chats))
const knowledgeChoice = new Map(Object.entries(savedChatPage.knowledge))
let liveChat = null
const chatSubmitGate = LibraryUI.submissionGate()
function inlineMarkdown(text) {
  const fragment = document.createDocumentFragment(),
    pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g
  let start = 0,
    match
  while ((match = pattern.exec(text))) {
    fragment.append(document.createTextNode(text.slice(start, match.index)))
    const value = match[0]
    if (value.startsWith('`'))
      fragment.append(el('code', {}, value.slice(1, -1)))
    else if (value.startsWith('**'))
      fragment.append(el('strong', {}, value.slice(2, -2)))
    else {
      const m = value.match(/^\[([^\]]+)\]\((.+)\)$/)
      fragment.append(
        el(
          'a',
          { href: m[2], target: '_blank', rel: 'noopener noreferrer' },
          m[1]
        )
      )
    }
    start = match.index + value.length
  }
  fragment.append(document.createTextNode(text.slice(start)))
  return fragment
}
function markdownView(text) {
  const container = el('div', { class: 'markdown' })
  for (const b of LibraryUI.markdownBlocks(text)) {
    if (b.type === 'code') {
      container.append(el('pre', {}, el('code', {}, b.text)))
      continue
    }
    if (b.type === 'list') {
      container.append(
        el(
          b.ordered ? 'ol' : 'ul',
          {},
          ...b.items.map((s) => el('li', {}, inlineMarkdown(s)))
        )
      )
      continue
    }
    if (b.type === 'table') {
      container.append(
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                ...b.header.map((s) => el('th', {}, inlineMarkdown(s)))
              )
            ),
            el(
              'tbody',
              {},
              ...b.rows.map((row) =>
                el('tr', {}, ...row.map((s) => el('td', {}, inlineMarkdown(s))))
              )
            )
          )
        )
      )
      continue
    }
    container.append(
      el(
        b.type === 'heading' ? 'h' + Math.min(4, b.level) : 'p',
        {},
        inlineMarkdown(b.text)
      )
    )
  }
  return container
}
function messageSources(turn) {
  const sources = turn.sources || []
  if (!sources.length) return null
  return el(
    'details',
    { class: 'answer-sources' },
    el('summary', {}, `参考资料 ${sources.length} · 当时使用的版本`),
    ...sources.map((s) =>
      el(
        'details',
        {},
        el(
          'summary',
          {},
          `[${s.number}] ${s.name || '资料'}${s.pages?.length ? ' · 页' + s.pages.join(',') : ''} · ${s.section || '正文'}`
        ),
        muted(
          '版本 ' +
            String(s.revision || '').slice(0, 12) +
            '；历史引用可能已有更新'
        ),
        el('pre', {}, s.text),
        btn('打开资料', () => edit(s.docId))
      )
    )
  )
}
async function knowledgeChat() {
  const project = state.project,
    endpoint = '/projects/' + project + '/chat/sessions'
  const [sessions, model] = await Promise.all([api(endpoint), api('/model')])
  if (state.project !== project || state.view !== 'search') return
  let selected = chatChoice.get(project)
  if (!sessions.some((s) => s.id === selected)) {
    selected = undefined
    chatChoice.set(project, selected)
    persistPage()
  }
  const conversation = selected
    ? await api(endpoint + '/' + selected)
    : { turns: [] }
  if (state.project !== project || state.view !== 'search') return
  const messages = el('div', {
      class: 'chat-messages',
      role: 'log',
      'aria-label': '问答记录'
    }),
    sessionList = el('aside', {
      class: 'chat-sessions',
      'aria-label': '对话列表'
    }),
    query = el('textarea', {
      rows: 2,
      maxlength: 3000,
      placeholder: '向你的知识库提问…',
      'aria-label': '问答问题'
    }),
    useKnowledge = el('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': '使用知识库',
      checked: knowledgeChoice.get(project) !== false
    })
  function updateKnowledgeMode() {
    knowledgeChoice.set(project, useKnowledge.checked)
    persistPage()
    query.placeholder = useKnowledge.checked
      ? '向你的知识库提问…'
      : '有什么我能帮忙的？'
  }
  useKnowledge.addEventListener('change', updateKnowledgeMode)
  updateKnowledgeMode()

  function draw(turns) {
    document.body.classList.toggle('chat-empty', !turns.length)
    messages.replaceChildren(
      ...(!turns.length
        ? [
            el(
              'div',
              { class: 'chat-welcome' },
              el('h2', {}, '我们要做什么？'),
              muted('从你的知识中，找到新的答案。')
            )
          ]
        : turns.flatMap((turn) => [
            el(
              'article',
              { class: 'chat-message user' },
              el('strong', {}, '你'),
              el('p', {}, turn.question)
            ),
            el(
              'article',
              { class: 'chat-message assistant' },
              el(
                'strong',
                {},
                turn.useKnowledge === false ? 'AI 助手' : '知识库助手'
              ),
              turn.status === 'running'
                ? el(
                    'div',
                    { class: 'stream-text' },
                    turn.answer || '正在检索与整理…'
                  )
                : markdownView(turn.answer || ''),
              turn.status === 'completed'
                ? null
                : muted(
                    turn.error ||
                      {
                        running: '生成中…',
                        failed: '回答失败',
                        interrupted: '已中断'
                      }[turn.status] ||
                      turn.status
                  ),
              messageSources(turn),
              turn.status === 'running'
                ? btn('停止回答', () =>
                    stopChatTurn(project, selected, turn.id)
                  )
                : turn.status !== 'completed'
                  ? btn('重新提问', () => {
                      query.value = turn.question
                      query.focus()
                    })
                  : null
            )
          ]))
    )
    messages.scrollTop = messages.scrollHeight
  }
  if (
    liveChat &&
    liveChat.project === project &&
    liveChat.session === selected
  ) {
    const index = conversation.turns.findIndex(
      (t) => t.id === liveChat.turnId || t.requestId === liveChat.requestId
    )
    if (index >= 0) conversation.turns[index] = liveChat.turn
    else conversation.turns.push(liveChat.turn)
    liveChat.redraw = () => draw(conversation.turns)
  }
  draw(conversation.turns)
  const newSession = async () => {
    const s = await api(endpoint, 'POST', {})
    chatChoice.set(project, s.id)
    persistPage()
    await knowledgeChat()
  }
  sessionList.append(
    el(
      'div',
      { class: 'history-heading' },
      el('strong', {}, '历史对话'),
      btn(
        '×',
        () => {
          document.body.classList.remove('history-open')
          sidebar()
        },
        'quiet'
      )
    ),
    btn('＋ 新对话', newSession, 'primary'),
    ...sessions.map((s) =>
      btn(
        s.title,
        async () => {
          chatChoice.set(project, s.id)
          persistPage()
          await knowledgeChat()
        },
        s.id === selected ? 'active' : ''
      )
    )
  )
  if (selected)
    sessionList.append(
      btn(
        '删除当前对话',
        async () => {
          if (!confirm('删除此对话及聊天记录？资料不受影响。')) return
          await api(endpoint + '/' + selected, 'DELETE', {})
          chatChoice.delete(project)
          persistPage()
          await knowledgeChat()
        },
        'quiet'
      )
    )
  const send = btn('↑', () => sendQuestion(), 'primary send-button'),
    stop = btn('停止', () => {
      if (liveChat) {
        liveChat.controller.abort()
        void stopChatTurn(
          liveChat.project,
          liveChat.session,
          liveChat.turnId
        ).catch(error)
      }
    })
  send.setAttribute('aria-label', '发送问题')
  send.title = '发送问题'
  stop.hidden = !liveChat
  async function sendQuestion() {
    if (chatSubmitGate.busy) return
    send.disabled = true
    try {
      return await chatSubmitGate.run(async () => {
        const question = query.value.trim()
        if (!question) return
        if (liveChat) {
          toast('有一个回答正在生成，请先停止或等待')
          return
        }
        if (!model.configured) {
          toast('尚未配置问答模型，请先在桌面应用中配置模型')
          return
        }
        if (!selected) {
          const s = await api(endpoint, 'POST', {})
          selected = s.id
          chatChoice.set(project, selected)
          persistPage()
        }
        const requestId = crypto.randomUUID(),
          controller = new AbortController(),
          turn = {
            id: 'pending',
            question,
            answer: '',
            status: 'running',
            useKnowledge: useKnowledge.checked,
            sources: [],
            diagnostics: {}
          }
        const runtime = {
          project,
          session: selected,
          controller,
          turnId: '',
          requestId,
          turn,
          redraw: () => draw(conversation.turns)
        }
        liveChat = runtime
        conversation.turns.push(turn)
        query.value = ''
        send.disabled = true
        stop.hidden = false
        draw(conversation.turns)
        let final = false
        try {
          const response = await sessionClient.request(
            '/api' + endpoint + '/' + selected + '/turns',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Rag-CSRF': state.csrf
              },
              body: JSON.stringify({
                requestId,
                question,
                useKnowledge: turn.useKnowledge,
                rewrite: true
              }),
              signal: controller.signal
            }
          )
          if (!response.ok) {
            const body = await response.json()
            throw Error(body.error || '无法开始回答')
          }
          const parse = LibraryUI.eventParser((event) => {
              if (event.turnId) {
                runtime.turnId = event.turnId
                turn.id = event.turnId
              }
              if (event.type === 'meta') {
                turn.sources = event.sources
                turn.diagnostics = event.diagnostics
                turn.retrievalOnly = event.retrievalOnly
              }
              if (event.type === 'token') turn.answer += event.text
              if (event.type === 'done') {
                Object.assign(turn, event.turn)
                final = true
              }
              if (event.type === 'error') {
                turn.status = event.status || 'failed'
                turn.error = event.message
                final = true
              }
              if (event.type === 'pending') {
                turn.error = '该请求已在处理中，请刷新对话查看状态'
                final = true
              }
              if (
                state.project === project &&
                state.view === 'search' &&
                chatChoice.get(project) === selected
              )
                runtime.redraw()
            }),
            reader = response.body.getReader(),
            decoder = new TextDecoder()
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            parse(decoder.decode(value, { stream: true }))
          }
          parse(decoder.decode())
          if (!final) throw Error('回答连接已中断，请刷新对话查看已保存的记录')
        } catch (e) {
          turn.status = 'interrupted'
          turn.error = controller.signal.aborted
            ? '回答已停止'
            : '连接中断，请刷新对话核对记录：' + e.message
          draw(conversation.turns)
        } finally {
          if (liveChat === runtime) liveChat = null
          send.disabled = false
          stop.hidden = true
          if (
            state.project === project &&
            state.view === 'search' &&
            chatChoice.get(project) === selected
          )
            await knowledgeChat()
        }
      })
    } finally {
      send.disabled = false
    }
  }
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void sendQuestion().catch(error)
    }
  })
  $('content').replaceChildren(
    el(
      'div',
      { class: 'chat-layout' },
      sessionList,
      el(
        'section',
        { class: 'chat-main' },
        messages,
        el(
          'div',
          { class: 'chat-composer' },
          query,
          el(
            'div',
            { class: 'chat-options' },
            el(
              'label',
              { class: 'knowledge-switch' },
              useKnowledge,
              '使用知识库'
            ),
            el(
              'span',
              { class: 'composer-model', title: '当前问答模型' },
              model.configured ? model.model : '未配置模型'
            ),
            send,
            stop
          )
        ),
        el(
          'p',
          {
            class: 'chat-note',
            title: '回答由当前模型生成；开启知识库时会发送相关资料片段。'
          },
          '回答请核对来源'
        )
      )
    )
  )
  persistPage()
  sidebar()
  if (liveChat && liveChat.project === project && liveChat.session === selected)
    stop.hidden = false
}
async function stopChatTurn(project, session, id) {
  if (!id || id === 'pending') return
  await api(
    '/projects/' +
      project +
      '/chat/sessions/' +
      session +
      '/turns/' +
      id +
      '/stop',
    'POST',
    {}
  )
  toast('已请求停止回答')
}
