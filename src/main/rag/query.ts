import type { ModelMessage } from 'ai'
export function extractQuery(messages: ModelMessage[]): string {
  const texts = messages
    .filter((m) => m.role === 'user')
    .slice(-2)
    .map((m) => {
      if (typeof m.content === 'string') {
        const marker = '【对方刚才说的话】'
        if (!m.content.includes(marker)) return m.content
        const focus = m.content
          .split(marker)[1]
          .split('【上一版提示】')[0]
          .replace(/^（还没说完）/, '')
          .trim()
        const cleaned = focus
          .split('\n')
          .filter((line) => !/^(?:嗯+|う+|啊+|哦+|好|好的|um|uh)[。.!！?？\s]*$/i.test(line.trim()))
          .join('\n')
          .trim()
        if (/^(?:它|他|她|这个|那个|这|那|上面|刚才)/.test(cleaned)) {
          const context = m.content
            .split(marker)[0]
            .replace('【之前对方说过的话】', '')
            .trim()
            .slice(-900)
          return context ? context + '\n' + cleaned : cleaned
        }
        return cleaned
      }
      const text = m.content
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('\n')
      if (!m.content.some((p) => p.type === 'image')) return text
      if (
        text === '这是屏幕截图' ||
        text === '这是下一部分截图，请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。'
      )
        return ''
      return text
        .replace(/^这是(?:下一部分截图和)?语音转录内容：\n/, '')
        .replace(
          /\n\n同时附上屏幕截图：$|\n请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。$/,
          ''
        )
        .trim()
    })
  if (!texts.at(-1)?.trim()) return ''
  const focused=/^(?:它|他|她|这个|那个|这|那|上面|刚才|继续|还有|然后)/.test(texts.at(-1)!.trim())?texts:[texts.at(-1)!]
  return focused
    .map((t) => t.slice(-1800))
    .join('\n')
    .slice(-3000)
    .trim()
}
