'use strict'
const uploadQueue = []
let uploading = false
function paintUploads() {
  const panel = $('upload-panel')
  if (!panel) return
  panel.hidden = !uploadQueue.length
  panel.replaceChildren(
    el(
      'div',
      { class: 'section-row' },
      el('strong', {}, '上传队列'),
      btn('收起已完成', () => {
        for (let i = uploadQueue.length - 1; i >= 0; i--)
          if (uploadQueue[i].processingDone || (uploadQueue[i].status === 'cancelled' && !uploadQueue[i].active))
            uploadQueue.splice(i, 1)
        paintUploads()
      })
    ),
    ...uploadQueue.map((row) =>
      el(
        'div',
        { class: 'upload-row' },
        el(
          'div',
          {},
          el('strong', {}, row.file.name),
          muted(
            `${state.projects?.find((p) => p.id === row.project)?.name || row.projectName} · ${row.message || { queued: '等待上传', uploading: '正在上传', uploaded: '后台已接收，自动解析、清洗并增量建索引', failed: '上传失败', cancelled: '已取消' }[row.status]}`
          ),
          row.processingMessage ? muted(row.processingMessage) : null,
          row.total ? muted(`${row.loaded || 0} / ${row.total} 字节`) : null
        ),
        el('progress', {
          value: row.progress,
          max: 100,
          'aria-label': row.file.name + '上传进度'
        }),
        el('span', {}, Math.floor(row.progress) + '%'),
        ['queued', 'uploading'].includes(row.status)
          ? btn('取消', () => {
              row.cancelled = true
              row.status = 'cancelled'
              row.cancelController?.abort()
              row.xhr?.abort()
              paintUploads()
            })
          : !row.active && (row.status === 'failed' || row.status === 'cancelled')
            ? btn('重试', () => {
                row.status = 'queued'
                row.cancelled = false
                row.message = ''
                paintUploads()
                void pumpUploads()
              })
            : row.receipt?.jobId
              ? btn('查看处理', () => jobDetail(row.receipt.jobId, '/projects/' + row.project))
              : null
      )
    )
  )
}
async function uploadFiles() {
  const project = state.project,
    projectName = state.projects?.find((p) => p.id === project)?.name || project,
    input = el('input', {
      type: 'file',
      multiple: '',
      accept: '.pdf,.docx,.md,.markdown,.txt,.png,.jpg,.jpeg,.webp,.xlsx,.pptx'
    })
  input.onchange = () => {
    if (input.files.length > 50) {
      error(Error('一次最多选择50个文件，请分批上传'))
      return
    }
    for (const file of input.files) {
      uploadQueue.push({
        file,
        project,
        projectName,
        submission: crypto.randomUUID(),
        status: 'queued',
        progress: 0,
        message: ''
      })
    }
    paintUploads()
    void pumpUploads()
  }
  input.click()
}
function sendBinaryUpload(row, csrf) {
  if (row.cancelled) return Promise.reject(new DOMException('上传已取消', 'AbortError'))
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    row.xhr = xhr
    xhr.open(
      'POST',
      '/api/projects/' +
        row.project +
        '/upload?name=' +
        encodeURIComponent(row.file.name) +
        '&submission=' +
        row.submission
    )
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Rag-CSRF', csrf)
    xhr.timeout = 300000
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        row.loaded = e.loaded
        row.total = e.total
        row.progress = Math.min(99, (100 * e.loaded) / e.total)
        paintUploads()
      }
    }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status > 599) {
        reject(Error('上传连接异常，请核对接收记录'))
        return
      }
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          headers: {
            'X-Rag-Auth-Error': xhr.getResponseHeader('X-Rag-Auth-Error') || ''
          }
        })
      )
    }
    xhr.onerror = () => reject(Error('连接中断'))
    xhr.ontimeout = () => reject(Error('上传超时'))
    xhr.onabort = () => reject(new DOMException('上传已取消', 'AbortError'))
    xhr.send(row.file)
  })
}
async function binaryUpload(row) {
  const controller = new AbortController()
  row.cancelController = controller
  const abort = () => row.xhr?.abort()
  controller.signal.addEventListener('abort', abort, { once: true })
  try {
    const response = await sessionClient.authorized((token) => sendBinaryUpload(row, token), {
      signal: controller.signal
    })
    let result
    try {
      result = await response.json()
    } catch {
      throw Error('后台返回无效，请检查接收记录后重试')
    }
    if (!response.ok) throw Error(result.error || '上传失败')
    return result
  } finally {
    controller.signal.removeEventListener('abort', abort)
    if (row.cancelController === controller) row.cancelController = null
  }
}
function acceptUpload(row, receipt, recovered = false) {
  row.receipt = receipt
  row.status = 'uploaded'
  row.progress = 100
  if (recovered) {
    row.message = '已核对：后台接收成功，无需重复提交'
  } else if (receipt.reused) {
    if (['failed', 'cancelled', 'needs_attention'].includes(receipt.status))
      row.message = '文件已存在，原处理任务需处理；未新建重复任务，请点击“查看处理”。'
    else if (receipt.pending === false || receipt.status === 'done')
      row.message = '文件已存在，已复用处理结果，未重复清洗或向量化。'
    else row.message = '文件已存在，已沿用原处理任务，不会重复清洗或向量化。'
    toast(row.file.name + '：' + row.message)
  } else {
    row.message = '后台已接收，自动解析、清洗并增量建索引'
  }
  row.file = new File([], row.file.name)
}
async function pumpUploads() {
  if (uploading) return
  uploading = true
  try {
    for (;;) {
      const row = uploadQueue.find((r) => r.status === 'queued')
      if (!row) break
      row.active = true
      row.loaded = 0
      row.total = row.file.size
      row.status = 'uploading'
      row.progress = 0
      paintUploads()
      try {
        if (!row.file.size || row.file.size > 30 * 1024 * 1024)
          throw Error('文件须大于0且不超过30MB')
        const receipt = await binaryUpload(row)
        acceptUpload(row, receipt)
      } catch (e) {
        let receipt
        try {
          receipt = await api('/projects/' + row.project + '/uploads/' + row.submission)
        } catch {}
        if (receipt) {
          acceptUpload(row, receipt, true)
        } else {
          row.status = row.cancelled ? 'cancelled' : 'failed'
          row.message = row.cancelled ? '已取消；未找到后台接收记录' : e.message + '，可单独重试'
        }
      } finally {
        row.active = false
        row.xhr = null
        paintUploads()
      }
    }
  } finally {
    uploading = false
    await projects().catch(error)
    if (state.view === 'documents' && !state.editor) await documents().catch(error)
  }
}

// Transport completion is independent of parsing and the project's index task.
let checkingUploadProcessing = false
async function refreshUploadProcessing() {
  if (checkingUploadProcessing) return
  checkingUploadProcessing = true
  try {
    for (const row of uploadQueue.filter((row) => row.receipt?.jobId && !row.processingDone)) {
      try {
        const endpoint = '/projects/' + row.project
        const [task, index, document] = await Promise.all([
          api(endpoint + '/tasks/' + row.receipt.jobId),
          api(endpoint + '/status'),
          row.receipt.docId ? api(endpoint + '/documents/' + row.receipt.docId) : Promise.resolve(null)
        ])
        if (task.status === 'queued') row.processingMessage = '等待解析'
        else if (task.status === 'running') row.processingMessage = '正在解析与清洗'
        else if (task.status === 'needs_attention')
          row.processingMessage = document?.indexReady
            ? '向量化完成 · 待人工复核，可决定保留或删除文档'
            : '待人工复核 · 正在或等待向量化' + (index.message ? '：' + index.message : '')
        else if (task.status === 'failed')
          row.processingMessage = '解析失败：' + (task.error || '请查看处理并重试')
        else if (task.status === 'cancelled') row.processingMessage = '解析已取消，可查看处理并重试'
        else if (task.status === 'done') {
          row.processingMessage =
            index.state === 'ready' && document?.processingStatus === 'ready'
              ? '解析完成 · 索引就绪'
              : index.state === 'error'
                ? '解析完成 · 索引失败：' + (index.message || '请到知识库管理重试')
                : '解析完成 · 等待或正在建立索引：' + (index.message || '')
          row.processingDone = index.state === 'ready' && document?.processingStatus === 'ready'
        }
      } catch (e) {
        row.processingMessage = '状态获取失败，将自动重试：' + e.message
      }
    }
    paintUploads()
  } finally {
    checkingUploadProcessing = false
  }
}
if (typeof window !== 'undefined') setInterval(() => void refreshUploadProcessing(), 2000)
