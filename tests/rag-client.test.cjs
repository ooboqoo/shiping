const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
const client = load('src/main/rag/client.ts')
test('query never creates a missing collection', async () => {
  const old = global.fetch,
    calls = []
  global.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response('{}', { status: 404 })
  }
  try {
    await assert.rejects(client.searchVectors([1, 0], ['chunk']))
    assert.equal(calls[0].init.method, 'GET')
    assert.ok(calls[0].url.endsWith('/shiping_knowledge_bgem3_v2'))
  } finally {
    global.fetch = old
  }
})
test('empty backend cannot masquerade as a healthy index', async () => {
  const old = global.fetch
  global.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith('/query')
          ? { ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] }
          : { id: 'collection' }
      )
    )
  try {
    await assert.rejects(client.searchVectors([1, 0], ['chunk']), /索引/)
  } finally {
    global.fetch = old
  }
})
test('model fingerprint invalidates pre-structure indexes', async () => {
  const old = global.fetch
  global.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith('/api/tags')
          ? { models: [{ name: 'bge-m3:latest', digest: 'test-digest' }] }
          : { embeddings: [[1, 0]] }
      )
    )
  try {
    assert.ok((await client.fingerprint()).endsWith(':structure-v2'))
  } finally {
    global.fetch = old
  }
})
