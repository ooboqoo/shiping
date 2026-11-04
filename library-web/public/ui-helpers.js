'use strict'
;(function (root) {
  function markdownBlocks(value) {
    const lines = String(value).replace(/\r\n?/g, '\n').split('\n'),
      blocks = []
    for (let i = 0; i < lines.length; ) {
      const line = lines[i]
      if (!line.trim()) {
        i++
        continue
      }
      const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
      if (fence) {
        const content = [],
          mark = fence[1][0],
          size = fence[1].length
        i++
        while (
          i < lines.length &&
          !new RegExp('^\\s*' + mark + '{' + size + ',}\\s*$').test(lines[i])
        )
          content.push(lines[i++])
        if (i < lines.length) i++
        blocks.push({
          type: 'code',
          language: fence[2].trim(),
          text: content.join('\n')
        })
        continue
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/)
      if (heading) {
        blocks.push({
          type: 'heading',
          level: heading[1].length,
          text: heading[2]
        })
        i++
        continue
      }
      if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
        const items = [],
          ordered = /^\s*\d+\./.test(line)
        while (i < lines.length && /^\s*(?:[-*+] |\d+\. )/.test(lines[i]))
          items.push(lines[i++].replace(/^\s*(?:[-*+] |\d+\. )/, ''))
        blocks.push({ type: 'list', ordered, items })
        continue
      }
      if (
        i + 1 < lines.length &&
        line.includes('|') &&
        /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        const cells = (s) =>
            s
              .trim()
              .replace(/^\||\|$/g, '')
              .split('|')
              .map((v) => v.trim()),
          header = cells(line),
          rows = []
        i += 2
        while (i < lines.length && lines[i].includes('|') && lines[i].trim())
          rows.push(cells(lines[i++]))
        blocks.push({ type: 'table', header, rows })
        continue
      }
      const content = [line]
      i++
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(?:#{1,6}\s|\s*[`~]{3}|\s*[-*+] |\s*\d+\. )/.test(lines[i])
      )
        content.push(lines[i++])
      blocks.push({ type: 'paragraph', text: content.join('\n') })
    }
    return blocks
  }
  function eventParser(callback) {
    let buffer = ''
    return (chunk) => {
      buffer += chunk
      if (buffer.length > 1024 * 1024) throw Error('回答数据异常')
      let match
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const data = block
          .split(/\r?\n/)
          .filter((s) => s.startsWith('data:'))
          .map((s) => s.slice(5).trimStart())
          .join('\n')
        if (data) callback(JSON.parse(data))
      }
    }
  }
  function submissionGate() {
    let busy = false
    return {
      get busy() {
        return busy
      },
      async run(work) {
        if (busy) return { skipped: true }
        busy = true
        try {
          return await work()
        } finally {
          busy = false
        }
      }
    }
  }
  /** Renew only rejections returned before dispatch; never replay an uncertain write/paid answer. */
  function createSessionClient({ fetcher = fetch } = {}) {
    let csrf = '',
      epoch = 0,
      pending = null
    function waitFor(promise, signal) {
      signal?.throwIfAborted()
      if (!signal) return promise
      return new Promise((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort)
          reject(signal.reason)
        }
        signal.addEventListener('abort', abort, { once: true })
        promise.then(
          (value) => {
            signal.removeEventListener('abort', abort)
            resolve(value)
          },
          (error) => {
            signal.removeEventListener('abort', abort)
            reject(error)
          }
        )
      })
    }
    function refresh() {
      if (pending) return pending
      pending = (async () => {
        const response = await fetcher('/api/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(10000)
        })
        if (!response.ok)
          throw Error(
            '无法恢复本机连接，请确认后台服务运行后重试；未保存内容会保留'
          )
        const value = await response.json()
        if (
          typeof value.csrf !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.csrf)
        )
          throw Error('本机连接验证无效，请稍后重试；未保存内容会保留')
        csrf = value.csrf
        epoch++
        return value
      })().finally(() => {
        pending = null
      })
      return pending
    }
    async function authorized(send, { signal } = {}) {
      signal?.throwIfAborted()
      const started = epoch,
        response = await send(csrf),
        kind = response.headers.get('X-Rag-Auth-Error')
      if (
        !(
          (response.status === 401 && kind === 'session') ||
          (response.status === 403 && kind === 'csrf')
        )
      )
        return response
      await response.body?.cancel().catch(() => {})
      signal?.throwIfAborted()
      if (epoch === started) await waitFor(refresh(), signal)
      signal?.throwIfAborted()
      // Exactly one retry. A second rejection is surfaced, with no loop or page reload.
      return send(csrf)
    }
    return {
      get csrf() {
        return csrf
      },
      refresh,
      authorized,
      request(route, init = {}) {
        if (
          typeof route !== 'string' ||
          !route.startsWith('/api/') ||
          route.startsWith('/api/internal/')
        )
          throw Error('无效的页面请求')
        return authorized(
          (token) => {
            const headers = new Headers(init.headers)
            if (!['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase()))
              headers.set('X-Rag-CSRF', token)
            return fetcher(route, {
              ...init,
              headers,
              credentials: 'same-origin'
            })
          },
          { signal: init.signal }
        )
      }
    }
  }
  function cleanPageState(value) {
    const v = value && typeof value === 'object' ? value : {}
    const pairs = (record, valid) =>
      record && typeof record === 'object' && !Array.isArray(record)
        ? Object.fromEntries(
            Object.entries(record).filter(
              ([k, val]) => /^[-\w]{1,100}$/.test(k) && valid(val)
            )
          )
        : {}
    return {
      view: ['search', 'libraries', 'documents', 'maintenance', 'projectTrash'].includes(
        v.view
      )
        ? v.view
        : 'search',
      project:
        typeof v.project === 'string' && /^[-\w]{1,100}$/.test(v.project)
          ? v.project
          : 'shiping',
      trash: v.trash === true,
      query: typeof v.query === 'string' ? v.query.slice(0, 1000) : '',
      chats: pairs(
        v.chats,
        (val) => typeof val === 'string' && /^[-\w]{1,100}$/.test(val)
      ),
      knowledge: pairs(v.knowledge, (val) => typeof val === 'boolean')
    }
  }
  function readPageState(storage) {
    try {
      return cleanPageState(
        JSON.parse((storage || root.sessionStorage).getItem('local-rag:page'))
      )
    } catch {
      return cleanPageState(null)
    }
  }
  function savePageState(value, storage) {
    try {
      ;(storage || root.sessionStorage).setItem(
        'local-rag:page',
        JSON.stringify(cleanPageState(value))
      )
    } catch {
      /* Browsing must remain usable when session storage is blocked. */
    }
  }
  const exports = {
    markdownBlocks,
    eventParser,
    submissionGate,
    createSessionClient,
    readPageState,
    savePageState
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = exports
  else root.LibraryUI = exports
})(globalThis)
