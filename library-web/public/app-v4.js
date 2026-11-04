'use strict'
const $ = (id) => document.getElementById(id)
const sessionClient = LibraryUI.createSessionClient()
const savedPage = LibraryUI.readPageState()
const state = {
  projects: [],
  project: savedPage.project,
  view: savedPage.view,
  csrf: '',
  trash: savedPage.trash,
  query: savedPage.query,
  dirty: false,
  editor: false,
  busy: false,
  renderId: 0,
  documentsRequest: 0
}
const pendingDocumentRemovals = new Map()
const removalRevisions = new Map()
const labels = {
  queued: '排队中',
  running: '处理中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  needs_attention: '需处理',
  ready: '已就绪',
  parsing: '解析与清洗中',
  waiting_index: '待索引',
  indexing: '索引中'
}
const views = {
  libraries: '知识库管理',
  documents: '资料库',
  projectTrash: '知识库回收站',
  search: '知识库问答',
  maintenance: '设置'
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on'))
      node.addEventListener(key.slice(2), (e) =>
        Promise.resolve(value(e)).catch(error)
      )
    else if (key === 'class') node.className = value
    else if (key === 'value') node.value = value
    else if (key === 'checked') node.checked = value
    else if (value !== undefined && value !== null)
      node.setAttribute(key, String(value))
  }
  for (const c of children.flat(Infinity))
    if (c !== null && c !== undefined && c !== false)
      node.append(c instanceof Node ? c : String(c))
  return node
}
function btn(text, action, kind = 'small') {
  return el('button', { class: kind, onclick: action }, text)
}
function muted(text) {
  return el('p', { class: 'muted-copy' }, text)
}
function error(e) {
  $('notice').hidden = false
  $('notice').textContent = e.message || String(e)
}
function toast(text) {
  $('toast').hidden = false
  $('toast').textContent = text
  setTimeout(() => ($('toast').hidden = true), 3500)
}
async function api(path, method = 'GET', body) {
  const res = await sessionClient.request('/api' + path, {
    method,
    signal: AbortSignal.timeout(
      path === '/model-providers' && method === 'POST'
        ? Math.max(
            30000,
            Math.min(65000, Number(body?.config?.timeoutMs || 30000) + 3000)
          )
        : 30000
    ),
    headers: {
      'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'X-Rag-CSRF': state.csrf } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const result = await res.json()
  if (!res.ok) throw Error(result.error || '操作失败')
  return result
}
const base = () => '/projects/' + state.project
function discard() {
  return !state.dirty || window.confirm('有未保存的修改，确认离开？')
}
function closeEditor() {
  state.dirty = false
  state.editor = false
  $('drawer').hidden = true
  $('drawer-backdrop').hidden = true
}
async function projects() {
  state.projects = await api('/projects')
  if (!state.projects.some((p) => p.id === state.project)) {
    if (state.view === 'documents') state.view = 'libraries'
    state.project = state.projects[0]?.id || 'shiping'
    state.trash = false
    state.query = ''
  }
  persistPage()
  sidebar()
}
function icon(name) {
  const paths = {
    home: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
    history: 'M3 10a9 9 0 1 1 2 8M3 4v6h6m3-4v6l4 2',
    library: 'M4 4h4v16H4ZM11 4h4v16h-4Zm7 0 4 1-3 15-4-1Z',
    settings:
      'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Zm7 9a4 4 0 1 0-8 0 4 4 0 0 0 8 0'
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: 20,
    height: 20,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.5,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true'
  }))
    svg.setAttribute(k, v)
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}
function persistPage() {
  LibraryUI.savePageState({
    view: state.view,
    project: state.project,
    trash: state.trash,
    query: state.query,
    chats: Object.fromEntries(chatChoice),
    knowledge: Object.fromEntries(knowledgeChoice)
  })
}
async function navigate(view) {
  if (!discard()) return
  closeEditor()
  state.view = view
  persistPage()
  if (view !== 'search') document.body.classList.remove('history-open')
  sidebar()
  await render()
}
function railButton(label, name, action, active = false) {
  const b = btn('', action, 'rail-button' + (active ? ' active' : ''))
  b.title = label
  b.setAttribute('aria-label', label)
  b.setAttribute('aria-pressed', String(active))
  b.append(icon(name))
  return b
}
function sidebar() {
  $('sidebar').replaceChildren(
    el(
      'nav',
      { 'aria-label': '主导航' },
      railButton(
        '主页',
        'home',
        () => navigate('search'),
        state.view === 'search'
      ),
      railButton(
        '历史对话',
        'history',
        async () => {
          const open = !document.body.classList.contains('history-open')
          await navigate('search')
          document.body.classList.toggle('history-open', open)
          sidebar()
        },
        document.body.classList.contains('history-open')
      ),
      railButton(
        '资料库',
        'library',
        () => navigate('libraries'),
        ['libraries', 'documents', 'projectTrash'].includes(state.view)
      )
    ),
    el(
      'div',
      { class: 'rail-bottom' },
      railButton(
        '设置',
        'settings',
        () => navigate('maintenance'),
        state.view === 'maintenance'
      ),
      el(
        'span',
        {
          class: 'local-avatar',
          title: '本机工作空间',
          'aria-label': '本机工作空间'
        },
        '本地'
      )
    )
  )
  document
    .querySelector('.topbar')
    .replaceChildren(
      el('span', { class: 'local-badge' }, el('i'), '仅本机访问')
    )
}
function heading(title, description, ...actions) {
  return el(
    'div',
    { class: 'view-header' },
    el('div', {}, el('h1', {}, title), muted(description)),
    el('div', { class: 'section-row' }, ...actions)
  )
}
async function render() {
  const view = state.view,
    renderId = ++state.renderId
  document.body.dataset.view = view
  $('notice').hidden = true
  $('content').setAttribute('aria-busy', 'true')
  $('content').replaceChildren(
    el(
      'div',
      { class: 'page-loading', role: 'status', 'aria-live': 'polite' },
      el('span', { class: 'loading-spinner', 'aria-hidden': 'true' }),
      el('span', {}, '正在加载' + views[view] + '…')
    )
  )
  try {
    if (view === 'libraries') await knowledgeLibraries()
    else if (view === 'documents') await documents()
    else if (view === 'search') await knowledgeChat()
    else if (view === 'projectTrash') await projectTrash()
    else await maintenance()
  } catch (e) {
    if (renderId !== state.renderId) return
    $('content').replaceChildren(
      el(
        'div',
        { class: 'page-loading', role: 'alert' },
        el('span', {}, '加载失败，请检查本机服务后重试。'),
        btn('重新加载', render)
      )
    )
    error(e)
  } finally {
    if (renderId === state.renderId)
      $('content').setAttribute('aria-busy', 'false')
  }
}
function createKnowledgeBase() {
  if (!discard() || state.busy) return
  const dialog = $('confirm-dialog'),
    name = el('input', {
      'aria-label': '知识库名称',
      placeholder: '给知识库起个名字',
      maxlength: '80',
      required: ''
    }),
    failure = el('p', { class: 'error-box', role: 'alert' }),
    cancel = btn('取消', () => dialog.close()),
    save = el('button', { type: 'submit', class: 'primary' }, '创建'),
    form = el(
      'form',
      {},
      el('h2', {}, '新建知识库'),
      name,
      failure,
      el('div', { class: 'dialog-actions' }, cancel, save)
    )
  cancel.type = 'button'
  failure.hidden = true
  let saving = false
  dialog.oncancel = (e) => {
    if (saving) e.preventDefault()
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const title = name.value.trim()
    if (!title || saving) {
      name.focus()
      return
    }
    saving = state.busy = true
    save.disabled = cancel.disabled = true
    save.textContent = '正在创建…'
    failure.hidden = true
    try {
      const p = await api('/projects', 'POST', { name: title })
      state.project = p.id
      state.trash = false
      state.query = ''
      await projects()
      dialog.close()
      await navigate('documents')
      toast('知识库已创建')
    } catch (e) {
      failure.textContent = e.message || '创建失败，请重试'
      failure.hidden = false
    } finally {
      saving = state.busy = false
      save.disabled = cancel.disabled = false
      save.textContent = '创建'
    }
  })
  dialog.replaceChildren(form)
  dialog.setAttribute('aria-label', '新建知识库')
  dialog.showModal()
  name.focus()
}
async function knowledgeLibraries() {
  const renderId = state.renderId
  await projects()
  if (state.view !== 'libraries' || renderId !== state.renderId) return
  $('content').replaceChildren(
    heading(
      '知识库管理',
      '每个知识库独立管理资料，点击进入查看和维护。',
      btn('＋ 新建知识库', createKnowledgeBase, 'primary'),
      btn('知识库回收站', () => navigate('projectTrash'))
    ),
    el(
      'div',
      { class: 'knowledge-grid' },
      ...state.projects.map(knowledgeCard)
    ),
    ...(!state.projects.length
      ? [muted('暂无知识库，点击新建知识库开始添加资料。')]
      : [])
  )
}
function knowledgeCard(p) {
  const summary = el(
      'summary',
      {
        'aria-label': p.name + '的更多操作',
        title: '更多操作'
      },
      '⋯'
    ),
    menu = el('details', { class: 'knowledge-card-menu' }, summary)
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    menu.open = false
    summary.focus()
    e.preventDefault()
  })
  summary.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.knowledge-card-menu[open]'))
      if (other !== menu) other.open = false
  })
  const action = (label, run, kind) =>
    btn(
      label,
      () => {
        menu.open = false
        return run()
      },
      kind
    )
  menu.append(
    el(
      'div',
      { class: 'knowledge-card-options', 'aria-label': '知识库操作' },
      action('重命名', () => renameKnowledgeBase(p)),
      action(
        p.id === 'shiping' ? '清空资料库' : '删除知识库',
        () => deleteKnowledgeBase(p),
        'danger'
      )
    )
  )
  return el(
    'section',
    { class: 'settings-card knowledge-card', 'aria-label': p.name },
    el(
      'button',
      {
        type: 'button',
        class: 'knowledge-card-entry',
        'aria-label': '打开知识库：' + p.name,
        onclick: async () => {
          if (!discard()) return
          state.project = p.id
          state.trash = false
          state.query = ''
          await navigate('documents')
        }
      },
      el('span', { class: 'knowledge-card-title' }, p.name),
      el(
        'span',
        { class: 'muted-copy' },
        p.documents + ' 份资料' + (p.id === 'shiping' ? ' · 默认知识库' : '')
      )
    ),
    menu
  )
}
async function deleteKnowledgeBase(project) {
  if (state.busy || !discard()) return
  const builtin = project.id === 'shiping'
  if (
    !window.confirm(
      builtin
        ? '将当前资料移入回收站，可恢复；正在执行的任务会取消。确认清空？'
        : `将知识库“${project.name}”移入回收站，立即停止检索。确认删除？`
    )
  )
    return
  state.busy = true
  try {
    await api(
      '/projects/' + project.id + (builtin ? '/clear' : ''),
      builtin ? 'POST' : 'DELETE',
      { version: project.version }
    )
    await projects()
    if (builtin && state.view === 'documents' && state.project === project.id)
      await documents()
    else await navigate('libraries')
    toast(builtin ? '资料已移入回收站' : '知识库已移入回收站')
  } finally {
    state.busy = false
  }
}
function renameKnowledgeBase(project) {
  if (!discard() || state.busy) return
  const dialog = $('confirm-dialog'),
    id = project.id,
    name = el('input', {
      value: project.name,
      'aria-label': '知识库名称',
      maxlength: '80',
      required: ''
    }),
    failure = el('p', { class: 'error-box', role: 'alert' }),
    cancel = btn('取消', () => dialog.close()),
    save = el('button', { type: 'submit', class: 'primary' }, '保存'),
    form = el(
      'form',
      {},
      el('h2', {}, '重命名知识库'),
      name,
      failure,
      el('div', { class: 'dialog-actions' }, cancel, save)
    )
  cancel.type = 'button'
  failure.hidden = true
  let saving = false,
    version = project.nameVersion || project.version
  dialog.oncancel = (e) => {
    if (saving) e.preventDefault()
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (saving) return
    const title = name.value.trim()
    let message = ''
    if (!title || title.length > 80 || /[\u0000-\u001f\u007f]/.test(title))
      message = '知识库名称应为1至80字符，且不能包含控制字符'
    else if (
      state.projects.some(
        (p) => p.id !== id && p.name.toLowerCase() === title.toLowerCase()
      )
    )
      message = '知识库名称已存在，请使用其他名称'
    if (message) {
      failure.textContent = message
      failure.hidden = false
      name.focus()
      return
    }
    saving = state.busy = true
    save.disabled = cancel.disabled = name.disabled = true
    save.textContent = '正在保存…'
    failure.hidden = true
    try {
      const updated = await api('/projects/' + id, 'PATCH', {
        name: title,
        version
      })
      Object.assign(project, updated)
      dialog.close()
      toast('知识库名称已保存')
      await projects()
      await render()
    } catch (e) {
      failure.textContent = e.message || '保存失败，请重试'
      failure.hidden = false
      // Refresh stale versions for the next attempt while preserving the typed name.
      await projects().catch(() => {})
      const current = state.projects.find((p) => p.id === id)
      version = current?.nameVersion || current?.version || version
    } finally {
      saving = state.busy = false
      save.disabled = cancel.disabled = name.disabled = false
      save.textContent = '保存'
    }
  })
  dialog.replaceChildren(form)
  dialog.setAttribute('aria-label', '重命名知识库')
  dialog.showModal()
  name.focus()
}
function knowledgeManagement() {
  return el(
    'nav',
    { class: 'knowledge-management', 'aria-label': '知识库管理' },
    btn('返回知识库列表', () => navigate('libraries')),
    el(
      'span',
      { class: 'muted-copy' },
      '知识库 / ' +
        (state.projects.find((p) => p.id === state.project)?.name || '资料')
    )
  )
}
async function removeDocument(project, doc, row) {
  const key = project + ':' + doc.id
  const invalidate = () =>
    removalRevisions.set(project, (removalRevisions.get(project) || 0) + 1)
  if (pendingDocumentRemovals.has(key)) return
  const parent = row?.parentNode,
    next = row?.nextSibling
  pendingDocumentRemovals.set(key, doc)
  invalidate()
  row?.remove()
  toast('已从列表移除，正在后台同步…')
  try {
    await api('/projects/' + project + '/documents/' + doc.id, 'DELETE', {
      version: doc.version
    })
    toast('已移入回收站，后台正在更新检索')
  } catch (e) {
    if (
      parent?.isConnected &&
      state.project === project &&
      state.view === 'documents' &&
      !state.trash
    )
      parent.insertBefore(row, next?.parentNode === parent ? next : null)
    toast('移除失败，正在恢复资料列表')
    error(e)
  } finally {
    pendingDocumentRemovals.delete(key)
    invalidate()
    window.dispatchEvent(
      new CustomEvent('library:documents-changed', { detail: { project } })
    )
  }
}
async function documents() {
  if (!state.projects.some((p) => p.id === state.project)) {
    await navigate('libraries')
    return
  }
  persistPage()
  const currentProject = state.project,
    currentRender = state.renderId,
    currentRevision = removalRevisions.get(currentProject) || 0,
    requestId = ++state.documentsRequest
  const endpoint = base(),
    p = state.projects.find((p) => p.id === state.project),
    listedDocs = await api(
      endpoint +
        '/documents?trash=' +
        (state.trash ? '1' : '0') +
        '&q=' +
        encodeURIComponent(state.query)
    ),
    status = await api(endpoint + '/status')
  if (
    state.view !== 'documents' ||
    currentProject !== state.project ||
    currentRender !== state.renderId ||
    currentRevision !== (removalRevisions.get(currentProject) || 0) ||
    requestId !== state.documentsRequest
  )
    return
  const docs = listedDocs.filter(
    (doc) =>
      state.trash || !pendingDocumentRemovals.has(currentProject + ':' + doc.id)
  )
  const search = el('input', {
    placeholder: '搜索资料',
    value: state.query,
    'aria-label': '搜索资料'
  })
  search.addEventListener('input', () => {
    state.query = search.value
  })
  search.addEventListener('change', async () => {
    state.query = search.value
    await documents()
  })
  if (p && p.documents !== status.documents) {
    p.documents = status.documents
    sidebar()
  }
  const header = heading(
    p?.name || '资料库',
    '上传资料后即可用于问答，处理过程自动完成。',
    btn('上传文件', upload, 'primary'),
    ...(p ? [btn('重命名', () => renameKnowledgeBase(p))] : []),
    btn('＋ 新建 Markdown', () => edit()),
    btn('刷新', async () => {
      await projects()
      await documents()
    })
  )
  const stats = el(
    'div',
    { class: 'stats' },
    muted(`共 ${status.documents} 份资料`)
  )
  const controls = el(
    'div',
    { class: 'filters' },
    search,
    btn('全部资料', async () => {
      state.trash = false
      await documents()
    }),
    btn('资料回收站', async () => {
      state.trash = true
      await documents()
    }),
    el(
      'a',
      { href: '/api' + endpoint + '/export-md', download: '' },
      '批量导出 Markdown'
    )
  )
  if (p)
    controls.append(
      btn(p.id === 'shiping' ? '清空资料库' : '删除知识库', () =>
        deleteKnowledgeBase(p)
      )
    )
  const bulk = el(
    'details',
    { class: 'library-actions' },
    el('summary', {}, '更多操作')
  )
  for (const item of [...controls.children].slice(3)) bulk.append(item)
  controls.append(bulk)
  const table = el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...(state.trash ? ['资料', '操作'] : ['资料', '状态', '操作']).map(
            (t) => el('th', {}, t)
          )
        )
      )
    ),
    body = el('tbody')
  for (const doc of docs) {
    let row
    const actions = el('div', { class: 'row-actions' })
    if (state.trash) {
      if (
        doc.purgeTask &&
        ['queued', 'running'].includes(doc.purgeTask.status)
      ) {
        actions.append(el('span', { role: 'status' }, '正在永久删除…'))
        watchDocumentPurge(currentProject, doc.purgeTask)
      } else if (doc.purgeTask?.status === 'failed') {
        actions.append(
          muted(doc.purgeTask.error || '永久删除失败，请重试'),
          btn(
            '重试永久删除',
            () => confirmDocumentPurge(currentProject, doc),
            'danger'
          )
        )
      } else {
        actions.append(
          btn('恢复', async () => {
            await api(endpoint + '/documents/' + doc.id + '/restore', 'POST', {
              version: doc.version
            })
            await projects()
            await documents()
          }),
          btn(
            '永久删除',
            () => confirmDocumentPurge(currentProject, doc),
            'danger'
          )
        )
      }
    } else {
      actions.append(
        btn('查看 / 编辑', () => edit(doc.id)),
        el(
          'a',
          {
            href: '/api' + endpoint + '/documents/' + doc.id + '/markdown',
            download: ''
          },
          '下载MD'
        )
      )
      if (doc.hasOriginal)
        actions.append(
          el(
            'a',
            {
              href: '/api' + endpoint + '/documents/' + doc.id + '/original',
              download: ''
            },
            '原件'
          )
        )
      if (
        doc.taskId &&
        ['needs_attention', 'failed'].includes(doc.processingStatus)
      )
        actions.append(btn('处理问题', () => jobDetail(doc.taskId)))
      actions.append(
        btn('移除', () => removeDocument(currentProject, doc, row))
      )
    }
    body.append(
      (row = el(
        'tr',
        {},
        el(
          'td',
          {},
          el('strong', {}, doc.name),
          muted(doc.source || 'Markdown')
        ),
        state.trash
          ? null
          : el(
              'td',
              {},
              labels[doc.processingStatus] || doc.processingStatus,
              doc.activeAvailable && doc.processingStatus !== 'ready'
                ? muted('当前版本仍可用，新版本处理中')
                : null
            ),
        el('td', {}, actions)
      ))
    )
  }
  table.append(body)
  $('content').replaceChildren(
    knowledgeManagement(),
    header,
    stats,
    controls,
    el(
      'div',
      {
        class: 'table-scroll',
        tabindex: '0',
        'aria-label': '资料列表，可横向滚动'
      },
      table
    ),
    ...(!docs.length
      ? [muted('暂无资料。上传文件或新建 Markdown 即可自动入库。')]
      : [])
  )
  if (state.trash) {
    const batches = await api(endpoint + '/clear-history')
    for (const batch of batches.filter((b) => !b.restored))
      $('content').append(
        btn(`恢复一次清空（${batch.documents}份）`, async () => {
          await api(endpoint + '/clear-restore', 'POST', { batch: batch.id })
          await projects()
          await documents()
        })
      )
  }
}
function openDrawer(...nodes) {
  state.editor = true
  $('drawer').replaceChildren(
    btn('关闭', () => {
      if (discard()) closeEditor()
    }),
    ...nodes
  )
  $('drawer').hidden = false
  $('drawer-backdrop').hidden = false
}
async function edit(id) {
  if (!discard()) return
  closeEditor()
  const endpoint = base(),
    doc = id ? await api(endpoint + '/documents/' + id) : null,
    name = el('input', {
      'aria-label': '资料名称',
      value: doc?.name || '',
      placeholder: '资料名称'
    }),
    text = el('textarea', {
      'aria-label': 'Markdown正文',
      rows: 22,
      value: doc?.text || ''
    })
  for (const input of [name, text])
    input.addEventListener('input', () => (state.dirty = true))
  const modes = el('div', { class: 'section-row' }),
    checks = ['conversation', 'screenshot'].map((mode) => {
      const check = el('input', {
        type: 'checkbox',
        checked: doc ? doc.modes.includes(mode) : true
      })
      check.addEventListener('change', () => (state.dirty = true))
      modes.append(
        el(
          'label',
          {},
          check,
          mode === 'conversation' ? '对话模式' : '截图模式'
        )
      )
      return [mode, check]
    })
  let savedId = id,
    savedVersion = doc?.version
  const save = btn(
    '保存',
    async () => {
      if (state.busy) return
      state.busy = true
      save.disabled = true
      const submitted = text.value,
        submittedName = name.value,
        submittedModes = checks.filter(([, c]) => c.checked).map(([m]) => m)
      try {
        const result = await api(
          endpoint + '/documents' + (savedId ? '/' + savedId : ''),
          savedId ? 'PUT' : 'POST',
          {
            name: submittedName,
            text: submitted,
            modes: submittedModes,
            ...(savedVersion ? { version: savedVersion } : {})
          }
        )
        savedId = result.id
        savedVersion = result.version
        if (
          text.value !== submitted ||
          name.value !== submittedName ||
          JSON.stringify(
            checks.filter(([, c]) => c.checked).map(([m]) => m)
          ) !== JSON.stringify(submittedModes)
        ) {
          toast('已保存提交版本；后续输入仍可继续保存')
          return
        }
        closeEditor()
        toast('已保存，资料更新中')
        await projects()
        await documents()
        return result
      } finally {
        state.busy = false
        save.disabled = false
      }
    },
    'primary'
  )
  openDrawer(
    el('h2', {}, id ? 'Markdown资料' : '新建Markdown'),
    muted(
      doc?.activeAvailable
        ? '保存后自动更新，更新完成前仍可使用原来的资料。'
        : '保存后自动处理，即可用于知识库问答。'
    ),
    name,
    el(
      'details',
      { class: 'document-advanced' },
      el('summary', {}, '高级选项'),
      modes
    ),
    text,
    save
  )
  if (doc?.hasOriginal)
    $('drawer').append(
      btn('重新解析原件', async () => {
        if (state.dirty) {
          toast('请先保存或放弃当前修改')
          return
        }
        if (
          !window.confirm(
            '将重新解析原件并生成新版本，成功后替换当前正文。人工修改内容请先下载保留。确认继续？'
          )
        )
          return
        await api(endpoint + '/documents/' + id + '/reparse', 'POST', {
          version: doc.version,
          confirm: true
        })
        closeEditor()
        await documents()
      })
    )
}
async function upload() {
  await uploadFiles()
}
async function jobDetail(id, capturedEndpoint) {
  if (!discard()) return
  closeEditor()
  const endpoint = capturedEndpoint || base(),
    job = await api(endpoint + '/tasks/' + id),
    report = job.result
  openDrawer(
    el('h2', {}, job.payload.sourceName || '索引任务'),
    muted(labels[job.status] || job.status),
    job.error ? muted(job.error) : null
  )
  if (['queued', 'running'].includes(job.status))
    $('drawer').append(
      btn('取消任务', async () => {
        await api(endpoint + '/tasks/' + id + '/cancel', 'POST', {})
        await jobDetail(id, endpoint)
      }),
      btn('刷新', () => jobDetail(id, endpoint))
    )
  const password =
    job.payload.ext === 'pdf'
      ? el('input', {
          type: 'password',
          autocomplete: 'off',
          placeholder: '加密 PDF 密码（仅本次使用）',
          'aria-label': 'PDF 密码'
        })
      : null
  if (['failed', 'cancelled'].includes(job.status)) {
    if (password) $('drawer').append(password)
    $('drawer').append(
      btn('重试', async () => {
        const value = password?.value
        if (password) password.value = ''
        const next = await api(
          endpoint + '/tasks/' + id + '/retry',
          'POST',
          value ? { password: value } : {}
        )
        closeEditor()
        toast('已重新排队')
        await jobDetail(next.id, endpoint)
      })
    )
  }
  if (!report?.pages) {
    if (report)
      $('drawer').append(el('pre', {}, JSON.stringify(report, null, 2)))
    return
  }
  $('drawer').append(
    el(
      'a',
      { href: '/api' + endpoint + '/tasks/' + id + '/original', download: '' },
      '下载本次处理原件'
    ),
    muted(`共${report.pages.length}个来源单元；非PDF单元号不代表PDF页码。`)
  )
  const excluded = [],
    reasons = {}
  for (const page of report.pages) {
    const box = el('input', {
        type: 'checkbox',
        checked: Boolean(page.excluded)
      }),
      reason = el('input', {
        placeholder: '排除页面需说明原因',
        value: page.exclusionReason || ''
      })
    excluded.push([page.number, box])
    reasons[page.number] = reason
    $('drawer').append(
      el(
        'details',
        {},
        el(
          'summary',
          {},
          `来源 ${page.number} · ${page.type} · ${page.status}`
        ),
        ...page.issues.map((i) => muted(i.reason)),
        el('pre', {}, page.elements.map((e) => e.text).join('\n')),
        el('label', {}, box, '明确排除此页'),
        reason
      )
    )
  }
  const text = el('textarea', {
    rows: 20,
    value: report.cleaned || '',
    'aria-label': '修正Markdown'
  })
  text.addEventListener('input', () => (state.dirty = true))
  $('drawer').append(
    el('h3', {}, 'Markdown结果'),
    text,
    el(
      'details',
      {},
      el('summary', {}, '查看原始解析及清洗摘要'),
      el('pre', {}, report.raw || ''),
      ...report.changes.map((c) => muted(c.reason + '：' + c.before))
    )
  )
  if (['needs_attention', 'failed'].includes(job.status))
    $('drawer').append(
      btn(
        '确认保留并更新索引',
        async () => {
          if (
            !window.confirm(
              '请确认已对照原件修正内容、核对警告及排除页原因。确认继续？'
            )
          )
            return
          const next = await api(
            endpoint + '/tasks/' + id + '/resolve',
            'POST',
            {
              version: job.updated,
              text: text.value,
              acknowledged: true,
              excludedPages: excluded
                .filter(([, c]) => c.checked)
                .map(([n]) => n),
              exclusionReasons: Object.fromEntries(
                Object.entries(reasons).map(([n, e]) => [n, e.value])
              )
            }
          )
          closeEditor()
          toast('已提交修正')
          await jobDetail(next.id, endpoint)
        },
        'primary'
      )
    )
}
async function maintenance() {
  const renderId = state.renderId
  const [retrieval, providers] = await Promise.all([
    api('/retrieval'),
    api('/model-providers')
  ])
  if (state.view !== 'maintenance' || renderId !== state.renderId) return
  const retrievalCard = retrievalSettings(retrieval, providers)
  const modelCards = modelProviderSettings(providers, {
    el,
    btn,
    muted,
    api,
    onSaved: (result) => retrievalCard.refreshSaved?.(result.rerank)
  })
  state.refreshSettings = async () => {
    const startedAt = Date.now()
    const latest = await api('/model-providers')
    if (state.view !== 'maintenance' || state.renderId !== renderId) return
    modelCards.forEach((card, index) =>
      card.refreshSaved?.(
        latest[index === 0 ? 'embedding' : 'rerank'],
        startedAt
      )
    )
    retrievalCard.refreshSaved?.(latest.rerank, startedAt)
  }
  $('content').replaceChildren(
    heading('设置', '模型配置与资料库检索。'),
    el(
      'section',
      {
        id: 'ai-model-settings',
        class: 'settings-group',
        'aria-label': 'AI 模型'
      },
      el('h2', {}, 'AI 模型'),
      muted('所有知识库共用以下模型配置，与 Shiping 中的 AI 模型设置同步。'),
      ...modelCards
    ),
    el(
      'section',
      { class: 'settings-group', 'aria-label': '资料库' },
      el('h2', {}, '资料库'),
      retrievalCard
    )
  )
}
async function projectTrash() {
  const renderId = state.renderId
  const items = await api('/projects?trash=1')
  if (state.view !== 'projectTrash' || renderId !== state.renderId) return
  $('content').replaceChildren(
    heading(
      '知识库回收站',
      '软删除可恢复；永久清理不会删除历史备份。',
      btn('返回知识库列表', () => navigate('libraries'))
    ),
    ...items.map((p) =>
      el(
        'div',
        { class: 'section-row' },
        el('strong', {}, p.name),
        muted(p.documents + '份活动资料'),
        btn('恢复', async () => {
          await api('/projects/' + p.id + '/project-restore', 'POST', {
            version: p.version
          })
          await projects()
          await projectTrash()
        }),
        btn('永久清理', async () => {
          const preview = await api('/projects/' + p.id + '/purge-preview')
          if (
            !window.confirm(
              `永久清理 ${preview.documents} 份资料、${preview.originalFiles} 个非共享原件、${preview.collections.length} 个登记集合、${preview.chatSessions || 0} 个对话（${preview.chatTurns || 0} 轮问答）。开始后不能恢复，失败只能重试。继续？`
            )
          )
            return
          if (window.prompt('输入知识库名称确认：') !== p.name) return
          const r = await api('/projects/' + p.id + '/purge', 'POST', {
            version: preview.version,
            confirm: true
          })
          toast(r.pending ? '清理未完成，请重试：' + r.error : '已永久清理')
          await projectTrash()
        })
      )
    )
  )
}
window.addEventListener('library:documents-changed', (event) => {
  void (async () => {
    await projects()
    if (
      state.project === event.detail.project &&
      state.view === 'documents' &&
      !state.editor
    )
      await documents()
  })().catch(error)
})
$('drawer-backdrop').onclick = () => {
  if (discard()) closeEditor()
}
document.addEventListener('click', (e) => {
  for (const menu of document.querySelectorAll('.knowledge-card-menu[open]'))
    if (!menu.contains(e.target)) menu.open = false
})
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    e.preventDefault()
    e.returnValue = ''
  }
})
async function boot() {
  const session = await sessionClient.refresh()
  state.csrf = session.csrf
  await projects()
  const link = new URLSearchParams(window.location.search)
  const task = link.get('task')
  if (link.get('project') === 'shiping' && task && /^[a-f0-9-]{36}$/.test(task)) {
    state.project = 'shiping'
    state.view = 'documents'
    await render()
    await jobDetail(task, '/projects/shiping')
  } else await render()
}
boot().catch(error)
setInterval(() => {
  if (
    !state.editor &&
    !state.busy &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(
      document.activeElement?.tagName
    ) &&
    state.view === 'documents' &&
    $('content').getAttribute('aria-busy') !== 'true' &&
    !document.querySelector('#content details[open]') &&
    !$('confirm-dialog').open
  ) {
    documents().catch(error)
  }
}, 4000)

setInterval(() => {
  if (state.view === 'maintenance') state.refreshSettings?.().catch(error)
}, 5000)
window.addEventListener('focus', () => {
  if (state.view === 'maintenance') state.refreshSettings?.().catch(error)
})

function retrievalSettings(config, providers) {
  let updatedAt = 0
  let legacy = providers?.rerank?.provider === 'local'
  let saved = config.reranker === true
  const toggle = el('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': '启用 Reranker 精排',
      checked: !legacy && saved
    }),
    status = el(
      'p',
      { class: 'muted-copy', 'aria-live': 'polite' },
      !legacy && saved ? '已开启' : '已关闭'
    )
  toggle.disabled = legacy === true
  toggle.addEventListener('change', async () => {
    if (toggle.disabled || legacy) return
    toggle.disabled = true
    updatedAt = Date.now()
    status.textContent = '正在保存…'
    try {
      const result = await api('/retrieval', 'PUT', {
        reranker: toggle.checked
      })
      saved = result.reranker
      toggle.checked = saved
      status.textContent = saved ? '已开启' : '已关闭'
    } catch (e) {
      toggle.checked = saved
      status.textContent = '保存失败，已保留原设置'
      error(e)
    } finally {
      updatedAt = Date.now()
      toggle.disabled = false
    }
  })
  const modelNote = muted(
    legacy
      ? '旧本机配置已停用，请先选择精排模型。'
      : `当前模型：${providers?.rerank?.model || '尚未配置'}`
  )
  const section = el(
    'section',
    { class: 'settings-card retrieval-settings' },
    el('h2', {}, '知识库检索'),
    el('label', { class: 'knowledge-switch' }, toggle, '启用 Reranker 精排'),
    muted(
      '使用 AI 模型中配置的精排模型优先排列更相关的资料片段。仅在使用知识库时生效；不可用时自动使用原检索结果。'
    ),
    modelNote,
    el('a', { href: '#ai-model-settings' }, '前往 AI 模型配置'),
    status
  )
  section.refreshSaved = (rerank, startedAt = Date.now() + 1) => {
    if (startedAt <= updatedAt || (toggle.disabled && !legacy)) return
    legacy = rerank.provider === 'local'
    saved = rerank.enabled === true
    toggle.checked = !legacy && saved
    toggle.disabled = legacy
    modelNote.textContent = legacy
      ? '旧本机配置已停用，请先选择精排模型。'
      : `当前模型：${rerank.model || '尚未配置'}`
    status.textContent = toggle.checked ? '已开启' : '已关闭'
  }
  return section
}
