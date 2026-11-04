'use strict'
const purgeWatchers = new Set()
function watchDocumentPurge(project, task) {
  if (
    !['queued', 'running'].includes(task.status) ||
    purgeWatchers.has(task.id)
  )
    return
  purgeWatchers.add(task.id)
  const poll = async () => {
    try {
      const current = await api('/projects/' + project + '/tasks/' + task.id)
      if (['queued', 'running'].includes(current.status)) {
        setTimeout(poll, 1200)
        return
      }
      purgeWatchers.delete(task.id)
      toast(
        current.status === 'done'
          ? '资料已永久删除，向量和数据库记录已清理'
          : '永久删除失败，请在资料回收站重试'
      )
      window.dispatchEvent(
        new CustomEvent('library:documents-changed', { detail: { project } })
      )
    } catch {
      purgeWatchers.delete(task.id)
      error(Error('无法获取永久删除进度，请刷新资料回收站查看'))
    }
  }
  setTimeout(poll, 600)
}
function confirmDocumentPurge(project, doc) {
  const dialog = $('confirm-dialog'),
    input = el('input', {
      'aria-label': '输入资料名称确认永久删除',
      placeholder: '请完整输入上方文件名',
      'aria-describedby': 'purge-file-name purge-name-error'
    }),
    failure = el('p', {
      id: 'purge-name-error',
      class: 'error-box',
      role: 'alert'
    }),
    cancel = el(
      'button',
      { type: 'button', onclick: () => dialog.close() },
      '取消'
    ),
    submit = el('button', { type: 'submit', class: 'danger' }, '永久删除'),
    form = el(
      'form',
      {},
      el('h2', {}, '永久删除资料'),
      el(
        'p',
        {},
        '将永久删除“' +
          doc.name +
          '”的正文、历史版本、处理记录、相关向量及引用此资料的问答记录，无法从回收站恢复。'
      ),
      muted(
        '其他资料仍使用的共享数据会保留；已有备份不受影响。输入完整资料名称确认。'
      ),
      el('p', { class: 'field-label' }, '需要输入的文件名：'),
      el('div', { id: 'purge-file-name', class: 'purge-file-name' }, doc.name),
      input,
      failure,
      el('div', { class: 'dialog-actions' }, cancel, submit)
    )
  failure.hidden = true
  submit.disabled = false
  let saving = false,
    validated = false
  function validateName() {
    validated = true
    const matches = input.value === doc.name
    failure.textContent = input.value
      ? '文件名不一致，请按上方显示的文件名重新输入。'
      : '请输入上方显示的完整文件名。'
    failure.hidden = matches
    input.setAttribute('aria-invalid', String(!matches))
    return matches
  }
  input.addEventListener('input', () => {
    if (validated) validateName()
  })
  input.addEventListener('blur', () => {
    if (input.value || validated) validateName()
  })
  dialog.oncancel = (event) => {
    if (saving) event.preventDefault()
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (saving) return
    if (!validateName()) {
      input.focus()
      return
    }
    saving = true
    submit.disabled = cancel.disabled = input.disabled = true
    submit.textContent = '正在提交…'
    failure.hidden = true
    try {
      const task = await api(
        '/projects/' + project + '/documents/' + doc.id + '/purge',
        'POST',
        { version: doc.version, confirm: true }
      )
      dialog.close()
      toast('永久删除已提交，正在后台清理')
      watchDocumentPurge(project, task)
      window.dispatchEvent(
        new CustomEvent('library:documents-changed', { detail: { project } })
      )
    } catch (e) {
      failure.textContent = e.message
      failure.hidden = false
    } finally {
      saving = false
      submit.disabled = cancel.disabled = input.disabled = false
      submit.textContent = '永久删除'
    }
  })
  dialog.setAttribute('aria-label', '永久删除资料')
  dialog.replaceChildren(form)
  dialog.showModal()
  input.focus()
}
