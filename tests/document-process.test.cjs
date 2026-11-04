const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  { EventEmitter } = require('node:events'),
  load = require('./load-source.cjs')
function parser(action) {
  return load('src/main/document-import.ts', {
    'node:fs': { existsSync: () => true },
    'node:child_process': {
      spawn: (exe, args, opts) => {
        const c = new EventEmitter()
        c.stdout = new EventEmitter()
        c.stderr = new EventEmitter()
        c.kill = () => {
          process.nextTick(() => c.emit('close', null, 'SIGKILL'))
          return true
        }
        process.nextTick(() => action(c, args, opts))
        return c
      }
    }
  })
}
test('document subprocess passes local assets, returns text and removes temporary input', async () => {
  let input
  const api = parser((c, args, opts) => {
    input = args[2]
    assert.equal(opts.env.ELECTRON_RUN_AS_NODE, '1')
    c.stdout.emit('data', JSON.stringify({ text: '本地事实731' }))
    c.emit('close', 0, null)
  })
  assert.equal(await api.extractLocalDocument(Buffer.from('sample'), 'png'), '本地事实731')
  await assert.rejects(fs.stat(input), /ENOENT/)
})
test('killed and oversized parser output is rejected and cleans temporary data', async () => {
  let input
  const api = parser((c, args) => {
    input = args[2]
    c.stdout.emit('data', 'x'.repeat(13 * 1024 * 1024))
  })
  await assert.rejects(api.extractLocalDocument(Buffer.from('sample'), 'png'), /超过上限/)
  await assert.rejects(fs.stat(input), /ENOENT/)
})
test('parser child errors cannot become successful empty documents and queue recovers', async () => {
  let count = 0
  const api = parser((c) => {
    c.stdout.emit(
      'data',
      JSON.stringify(++count === 1 ? { error: '文件损坏' } : { text: '恢复成功' })
    )
    c.emit('close', count === 1 ? 1 : 0, null)
  })
  await assert.rejects(api.extractLocalDocument(Buffer.from('bad'), 'xlsx'), /文件损坏/)
  assert.equal(await api.extractLocalDocument(Buffer.from('good'), 'xlsx'), '恢复成功')
})

test('UTF-8 text split across stdout chunks remains intact', async () => {
  const encoded = Buffer.from(JSON.stringify({ text: '青松知识库' }))
  const split = encoded.indexOf(Buffer.from('青')) + 1
  const api = parser((c) => {
    c.stdout.emit('data', encoded.subarray(0, split))
    c.stdout.emit('data', encoded.subarray(split))
    c.emit('close', 0, null)
  })
  assert.equal(await api.extractLocalDocument(Buffer.from('sample'), 'png'), '青松知识库')
})
