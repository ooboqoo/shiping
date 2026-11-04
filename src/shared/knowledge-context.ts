/** Shared full-text prompt; refactoring storage must not change answer instructions. */
export function formatKnowledgePrompt(docs: { name: string; text: string }[]): string {
  if (!docs.length) return ''
  const blocks = docs.map(
    (doc) => `<资料 name="${doc.name.replaceAll('"', "'")}">\n${doc.text}\n</资料>`
  )
  return [
    '# 参考资料',
    '以下是用户本人提供的资料（如简历、准备好的问答、笔记、参考文档），每份放在一个 <资料> 标签里。作答时：',
    [
      '- 问题与资料相关时，优先依据资料作答；涉及用户本人的经历时，以第一人称结合资料里的项目、数据和说法；',
      '- 资料里有与问题对应的现成回答时，以它为准，保留其要点和说法；',
      '- 资料与问题无关时忽略它，也不要提及资料本身；',
      '- 分隔线之后的任务说明和输出格式要求优先于本节。'
    ].join('\n'),
    ...blocks,
    '---'
  ].join('\n\n')
}
