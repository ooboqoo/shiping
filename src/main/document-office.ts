import { posix } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
// yauzl streams entries so inflated size limits are enforced before buffering.
import yauzl from 'yauzl'
const MAX_ENTRY = 5 * 1024 * 1024,
  MAX_TOTAL = 80 * 1024 * 1024
const list = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x])
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false
})
function xml(data: Buffer | undefined): any {
  if (!data) return {}
  const s = data.toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw Error('不支持含 DTD 或实体声明的文档')
  return parser.parse(s)
}
async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true },
      (error: Error | null, zip: any) => {
        if (error || !zip) return reject(Error('Office 文档 ZIP 压缩内容损坏'))
        const result = new Map<string, Buffer>()
        let count = 0,
          total = 0,
          done = false
        const fail = (e: Error) => {
          if (done) return
          done = true
          zip.close()
          reject(e)
        }
        zip.on('error', () => fail(Error('Office 文档 ZIP 压缩内容损坏')))
        zip.on('end', () => {
          if (!done) {
            done = true
            resolve(result)
          }
        })
        zip.on('entry', (entry: any) => {
          if (
            ++count > 3000 ||
            entry.uncompressedSize > MAX_ENTRY ||
            total + entry.uncompressedSize > MAX_TOTAL
          )
            return fail(Error('文档解压大小超过上限，请拆分文件'))
          const name = entry.fileName
          if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
            return fail(Error('文档包含无效路径'))
          if (/\/$/.test(name)) {
            zip.readEntry()
            return
          }
          zip.openReadStream(entry, (err: Error | null, stream: any) => {
            if (err) return fail(Error('文档解压失败'))
            const chunks: Buffer[] = []
            let size = 0
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length
              total += chunk.length
              if (size > MAX_ENTRY || total > MAX_TOTAL) {
                stream.destroy()
                fail(Error('文档解压大小超过上限'))
              } else chunks.push(chunk)
            })
            stream.on('error', () => fail(Error('文档解压失败')))
            stream.on('end', () => {
              if (!done) {
                result.set(name, Buffer.concat(chunks))
                zip.readEntry()
              }
            })
          })
        })
        zip.readEntry()
      }
    )
  })
}
function relations(files: Map<string, Buffer>, file: string) {
  const rel = posix.join(posix.dirname(file), '_rels', posix.basename(file) + '.rels')
  return list(xml(files.get(rel)).Relationships?.Relationship)
    .filter((r) => r['@TargetMode'] !== 'External')
    .map((r) => {
      const target = String(r['@Target'] ?? '')
      const path = target.startsWith('/')
        ? target.slice(1)
        : posix.normalize(posix.join(posix.dirname(file), target))
      if (path.startsWith('../') || path.includes('://')) throw Error('文档关联路径无效')
      return { ...r, path }
    })
}
function paragraphs(node: any): string[] {
  if (!node || typeof node !== 'object') return []
  if (Object.hasOwn(node, 'p'))
    return list(node.p).flatMap((p) => {
      const parts: string[] = []
      const walk = (v: any, key = '') => {
        if (key === 't') {
          parts.push(typeof v === 'object' ? String(v['#text'] ?? '') : String(v))
          return
        }
        if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) for (const a of list(x)) walk(a, k)
      }
      walk(p)
      return [parts.join('')]
    })
  return Object.values(node).flatMap((v) => list(v).flatMap(paragraphs))
}
function rich(value: any): string {
  return value == null
    ? ''
    : typeof value === 'object'
      ? [
          ...list(value.t).map((v) =>
            typeof v === 'object' ? String(v['#text'] ?? '') : String(v)
          ),
          ...list(value.r).map((r) => rich({ t: r.t }))
        ].join('')
      : String(value)
}
export async function readOffice(
  buffer: Buffer,
  ext: string,
  recognize: (data: Buffer) => Promise<string>,
  markdown = false
): Promise<string> {
  const files = await unzip(buffer),
    out: string[] = []
  if (ext === 'xlsx') {
    const workbook = xml(files.get('xl/workbook.xml')).workbook
    if (!workbook) throw Error('Excel 文档缺少工作簿')
    const rel = relations(files, 'xl/workbook.xml'),
      strings = list(xml(files.get('xl/sharedStrings.xml')).sst?.si).map(rich)
    let cells = 0
    for (const sheet of list(workbook.sheets?.sheet)) {
      out.push(`# 工作表：${sheet['@name']}`)
      const path = rel.find((r) => r['@Id'] === sheet['@id'])?.path
      if (!path || !files.has(path)) throw Error('Excel 工作表关联缺失')
      const worksheet = xml(files.get(path)).worksheet,
        grid: { row: string; values: Map<string, string> }[] = [],
        columns = new Set<string>()
      for (const row of list(worksheet?.sheetData?.row)) {
        const fields = new Map<string, string>()
        const values = list(row.c).map((c) => {
          if (++cells > 100000) throw Error('Excel 单元格数量超过上限')
          let v = c.v
          if (c['@t'] === 's') v = strings[Number(v)] ?? ''
          else if (c['@t'] === 'inlineStr') v = rich(c.is)
          else if (c.f !== undefined && v === undefined)
            v = '[公式无缓存值，请在 Excel 中计算并保存]'
          const coordinate = String(c['@r'] || '?'),
            column = coordinate.match(/^[A-Z]+/)?.[0]
          if (column) {
            columns.add(column)
            fields.set(column, String(v ?? ''))
          }
          return `${coordinate}: ${v ?? ''}`
        })
        if (values.length) {
          if (markdown) grid.push({ row: String(row['@r'] || '?'), values: fields })
          else out.push(`行 ${row['@r'] ?? '?'} | ${values.join(' | ')}`)
        }
      }
      if (markdown && grid.length) {
        const index = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0),
          cols = [...columns].sort((a, b) => index(a) - index(b)),
          escape = (value: string) =>
            value
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\|/g, '\\|')
              .replace(/\r?\n/g, '<br>'),
          line = (values: string[]) => '| ' + values.map(escape).join(' | ') + ' |'
        if (cols.length > 128) throw Error('Excel超过128个有效列，请拆分工作表')
        out.push(
          [
            line([
              '原行号',
              ...cols.map(
                (c) => c + (grid[0].values.get(c) ? '（首行：' + grid[0].values.get(c) + '）' : '')
              )
            ]),
            line(['---', ...cols.map(() => '---')]),
            ...grid.map((row) => line([row.row, ...cols.map((c) => row.values.get(c) || '')]))
          ].join('\n')
        )
        if (worksheet.mergeCells) out.push('[需复核：Excel包含合并单元格，请核对行列关系]')
      }
    }
  } else {
    const pres = xml(files.get('ppt/presentation.xml')).presentation
    if (!pres) throw Error('PPT 文档缺少演示文稿')
    const rel = relations(files, 'ppt/presentation.xml'),
      slides = list(pres.sldIdLst?.sldId)
    if (slides.length > 150) throw Error('PPT 超过150页，请拆分文件')
    let imageCount = 0
    for (let i = 0; i < slides.length; i++) {
      const file = rel.find((r) => r['@Id'] === slides[i]['@id'])?.path
      if (!file || !files.has(file)) throw Error('PPT 幻灯片关联缺失')
      const node = xml(files.get(file))
      out.push(`# 幻灯片 ${i + 1}`, ...paragraphs(node))
      const refs = relations(files, file)
      for (const r of refs.filter((r) => String(r['@Type']).endsWith('notesSlide')))
        out.push('## 备注', ...paragraphs(xml(files.get(r.path))))
      const embedIds = new Set<string>()
      const walk = (v: any) => {
        if (!v || typeof v !== 'object') return
        if (v['@embed']) embedIds.add(v['@embed'])
        for (const x of Object.values(v)) for (const y of list(x)) walk(y)
      }
      walk(node)
      for (const id of embedIds) {
        const r = refs.find((r) => r['@Id'] === id)
        if (!r) continue
        if (!/\.(png|jpe?g|webp)$/i.test(r.path)) {
          out.push('[图片格式不支持 OCR]')
          continue
        }
        if (++imageCount > 150) throw Error('PPT 图片数量超过150张，请拆分文件')
        const data = files.get(r.path)
        if (!data) throw Error('PPT 图片内容缺失')
        const text = await recognize(data)
        if (text.trim()) out.push('## 图片识别', text)
      }
    }
  }
  return out.join('\n\n')
}

export async function validateOffice(buffer: Buffer) {
  const files = await unzip(buffer)
  for (const [name, data] of files)
    if (name.endsWith('.xml') && /<!DOCTYPE|<!ENTITY/i.test(data.toString('utf8')))
      throw Error('不支持含DTD或实体声明的文档')
}
