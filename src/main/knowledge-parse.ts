import { extractLocalDocument } from './document-import'
import { readFile, stat } from 'fs/promises'
import { extname } from 'path'
import { KNOWLEDGE_EXTENSIONS } from '../shared/knowledge'

/**
 * Text out of an imported 资料库 file. The parsers are loaded on first use, so
 * they cost nothing at startup. Every failure is an Error whose message is
 * shown to the user as is.
 */

/** Past this a file is almost certainly not what the user meant to bring */
const MAX_FILE_BYTES = 30 * 1024 * 1024
/** Past this the text would not fit any model's context next to the question */
const MAX_TEXT_CHARS = 200_000

export async function extractFileText(filePath: string): Promise<string> {
  const ext = extname(filePath).slice(1).toLowerCase()
  if (ext === 'doc') throw new Error('不支持旧版 .doc，请用 Word 另存为 .docx 后再导入')
  if (!KNOWLEDGE_EXTENSIONS.includes(ext)) {
    throw new Error('不支持这种文件，可导入 PDF、DOCX、Markdown、TXT、图片、XLSX 和 PPTX')
  }

  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) throw new Error('找不到这个文件，可能已被移动或删除')
  if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 30MB，请只导入需要的部分')

  return extractBufferText(await readFile(filePath), ext)
}

export async function extractBufferText(
  buffer: Buffer,
  ext: string,
  maxChars = MAX_TEXT_CHARS
): Promise<string> {
  ext = ext.toLowerCase().replace(/^\./, '')
  if (!KNOWLEDGE_EXTENSIONS.includes(ext) || buffer.length > MAX_FILE_BYTES)
    throw new Error('文件类型不支持或超过30MB')
  let text: string
  if (['pdf', 'png', 'jpg', 'jpeg', 'webp', 'xlsx', 'pptx'].includes(ext))
    text = await extractLocalDocument(buffer, ext)
  else if (ext === 'docx') text = await readDocx(buffer)
  else text = decodeText(buffer)

  text = normalizeText(text)
  if (!text) {
    throw new Error(
      ext === 'pdf'
        ? '没有提取到文字，可能是扫描件或图片，请复制文字后用「新建文本」粘贴'
        : '没有提取到文字'
    )
  }
  if (text.length > maxChars) {
    throw new Error(`文字太多（${Math.round(text.length / 10000)} 万字），请只导入需要的部分`)
  }
  return text
}

async function readDocx(buffer: Buffer): Promise<string> {
  const { default: mammoth } = await import('mammoth')
  try {
    const { value } = await mammoth.extractRawText({ buffer })
    return value
  } catch {
    throw new Error('Word 文件解析失败，文件可能已损坏或不是 .docx 格式')
  }
}

/**
 * Plain text in whatever encoding the file was saved in: UTF-8 (with or without
 * a BOM), UTF-16 with a BOM (Notepad's 「Unicode」), else GBK — what older
 * Chinese Windows tools write
 */
export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer)
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer)
  try {
    // Strips a UTF-8 BOM by itself
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gb18030').decode(buffer)
  }
}

/**
 * One newline style, no trailing spaces, at most one blank line in a row. PDF
 * fonts often map characters to their Kangxi radical look-alikes (「⼩」 U+2F29
 * for 「小」), which read as other characters to a model; NFKC maps them back.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/[\u2f00-\u2fdf]/g, (radical) => radical.normalize('NFKC'))
    .replace(/\r\n?/g, '\n')
    .replaceAll('\0', '')
    .replace(/[ \t\u00a0\u3000]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
