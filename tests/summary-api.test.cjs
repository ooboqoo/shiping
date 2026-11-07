const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const createLoader = require('./voice-load-source.cjs')
test('background summary uses supported GPT completion limit and an isolated small prompt', async () => {
  let request
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (x) => (body += x))
    req.on('end', () => {
      request = JSON.parse(body)
      if (request.max_tokens !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unsupported parameter max_tokens' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'summary',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-6-sol',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '问题：缓存。AI建议：先删缓存。' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
        })
      )
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const profile = {
      apiKey: 'test',
      apiBaseURL: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'gpt-6-sol'
    }
    const ai = createLoader({
      './api-fetch': { apiFetch: (...a) => fetch(...a) },
      './settings': { getModeProfile: () => profile, settings: {} },
      './knowledge': { getKnowledgePrompt: () => 'DO NOT SEND PRIVATE KNOWLEDGE' },
      './external-knowledge': {
        getExternalReference: () => {
          throw new Error('summary must not retrieve')
        }
      }
    })('src/main/ai.ts')
    const result = await ai.summarizeConversation('面试官问题：缓存', new AbortController().signal)
    assert(result.includes('缓存'))
    assert.equal(request.max_completion_tokens, 400)
    assert.equal(request.max_tokens, undefined)
    assert(!JSON.stringify(request).includes('PRIVATE KNOWLEDGE'))
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})
