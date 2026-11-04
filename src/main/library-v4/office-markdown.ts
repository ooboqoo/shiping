import { XMLParser } from 'fast-xml-parser'
import mammoth from 'mammoth'
import { validateOffice } from '../document-office'
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  unpairedTags: ['img', 'br', 'hr'],
  parseTagValue: false,
  trimValues: false
})
const cell = (value: string) => value.trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>')
export function htmlMarkdown(html: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(html)) throw Error('不接受HTML实体声明')
  const tree = parser.parse(html)
  const render = (nodes: any[], depth = 0): string =>
    nodes
      .map((node) => {
        const tag = Object.keys(node).find((k) => k !== ':@')
        if (!tag) return ''
        if (tag === '#text') return String(node[tag])
        const children = node[tag] || [],
          attrs = node[':@'] || {},
          content = () => render(children, depth)
        if (['script', 'style', 'iframe', 'object'].includes(tag)) return ''
        if (/^h[1-6]$/.test(tag))
          return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + content().trim() + '\n\n'
        if (tag === 'p' || tag === 'div') return '\n\n' + content().trim() + '\n\n'
        if (tag === 'br') return '\n'
        if (tag === 'pre') return '\n\n```\n' + content().replace(/^\n+|\n+$/g, '') + '\n```\n\n'
        if (tag === 'code') return '`' + content() + '`'
        if (tag === 'strong' || tag === 'b') return '**' + content() + '**'
        if (tag === 'em' || tag === 'i') return '*' + content() + '*'
        if (tag === 'ul' || tag === 'ol') {
          let index = 0
          return (
            '\n' +
            children
              .map((n: any) =>
                n.li
                  ? '  '.repeat(depth) +
                    (tag === 'ol' ? ++index + '. ' : '- ') +
                    render(n.li, depth + 1).trim() +
                    '\n'
                  : ''
              )
              .join('') +
            '\n'
          )
        }
        if (tag === 'a') {
          const text = content(),
            url = String(attrs['@href'] || '')
          return /^https?:\/\//i.test(url)
            ? '[' + text + '](' + url.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29')) + ')'
            : text
        }
        if (tag === 'img') {
          const src = String(attrs['@src'] || '')
          return src.startsWith('shiping-ocr:')
            ? '\n\n图片文字：' + decodeURIComponent(src.slice(10)) + '\n\n'
            : '\n\n[需复核：Word图片未能可靠识别]\n\n'
        }
        if (tag === 'table') {
          const collect = (nodes: any[]): any[] =>
              nodes.flatMap((n) =>
                n.tr ? [n.tr] : n.thead ? collect(n.thead) : n.tbody ? collect(n.tbody) : []
              ),
            rows = collect(children).map((row) =>
              row
                .filter((n: any) => n.td || n.th)
                .map((n: any) => {
                  if (n[':@']?.['@colspan'] || n[':@']?.['@rowspan'])
                    throw Error('Word合并单元格需要核对，不能自动展平成普通表格')
                  return cell(render(n.td || n.th))
                })
            )
          if (!rows.length) return ''
          const width = Math.max(...rows.map((r) => r.length)),
            line = (r: string[]) =>
              '| ' + Array.from({ length: width }, (_, i) => r[i] || '').join(' | ') + ' |\n'
          return (
            '\n\n' +
            line(rows[0]) +
            line(Array(width).fill('---')) +
            rows.slice(1).map(line).join('') +
            '\n'
          )
        }
        return content()
      })
      .join('')
  return render(tree).trim() + '\n'
}
export async function wordMarkdown(
  buffer: Buffer,
  recognize: (data: Buffer) => Promise<string>
): Promise<string> {
  await validateOffice(buffer)
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async (image) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.contentType))
          return { src: 'unresolved' }
        try {
          const text = await recognize(await image.readAsBuffer())
          return { src: text.trim() ? 'shiping-ocr:' + encodeURIComponent(text) : 'unresolved' }
        } catch {
          return { src: 'unresolved' }
        }
      })
    }
  )
  const markdown = htmlMarkdown(result.value),
    unsupported = result.messages.filter(
      (m) => !/Unrecognised paragraph style|Unrecognised run style/i.test(m.message)
    )
  return markdown + (unsupported.length ? '\n[需复核：Word存在未能可靠恢复的结构]\n' : '')
}
