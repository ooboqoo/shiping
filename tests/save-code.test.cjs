const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-source.cjs')

const ANSWER = [
  '**思路**：用哈希表记录出现过的数。',
  '',
  '```ts',
  'function twoSum(nums: number[], target: number) {}',
  '```',
  '',
  '时间复杂度 O(n)。',
  ''
].join('\n')

/** save-code.ts with a clipboard that records what it was given */
function loadSaveCode(settings) {
  const written = []
  const electron = { clipboard: { writeText: async (text) => written.push(text) } }
  const mocks = {
    electron,
    './settings': {
      settings: { codeAutoSave: false, codeSaveDir: '', ...settings }
    }
  }
  return { ...load('src/main/save-code.ts', mocks), written }
}

test('code: only the first code block, without its fences', () => {
  const { clipboardText } = loadSaveCode({})
  assert.equal(clipboardText(ANSWER, 'code'), 'function twoSum(nums: number[], target: number) {}')
  assert.equal(clipboardText('答案是 B。', 'code'), null)
})

test('answer: the whole answer as written, Markdown included', () => {
  const { clipboardText } = loadSaveCode({})
  assert.equal(clipboardText(ANSWER, 'answer'), ANSWER.trim())
  assert.equal(clipboardText('答案是 B。', 'answer'), '答案是 B。')
  assert.equal(clipboardText('  \n', 'answer'), null)
})

test('the clipboard is written only with the switch on, with the chosen content', async () => {
  const off = loadSaveCode({ codeCopyToClipboard: false, clipboardContent: 'answer' })
  await off.copyAnswerToClipboard(ANSWER)
  assert.deepEqual(off.written, [])

  const whole = loadSaveCode({ codeCopyToClipboard: true, clipboardContent: 'answer' })
  await whole.copyAnswerToClipboard('答案是 B。')
  assert.deepEqual(whole.written, ['答案是 B。'])

  // A non-coding answer leaves the clipboard alone while only code is wanted
  const code = loadSaveCode({ codeCopyToClipboard: true, clipboardContent: 'code' })
  await code.copyAnswerToClipboard('答案是 B。')
  assert.deepEqual(code.written, [])
})
