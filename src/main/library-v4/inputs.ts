import { decodeBase64Bounded } from './base64'
import { basename, extname } from 'node:path'
export function uploadValue(file: { name: string; data: Buffer }) {
  const ext = extname(file.name).slice(1).toLowerCase()
  if (
    file.name !== basename(file.name) ||
    /[\\/\x00-\x1F]/.test(file.name) ||
    file.name.length > 180 ||
    ![
      'pdf',
      'docx',
      'md',
      'markdown',
      'txt',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'xlsx',
      'pptx'
    ].includes(ext) ||
    !file.data.length ||
    file.data.length > 30 * 1024 * 1024
  )
    throw Error('上传文件格式或大小无效')
  return ext
}
export function decode(value: unknown): Buffer {
  return decodeBase64Bounded(value)
}
