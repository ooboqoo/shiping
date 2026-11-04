/** Strict, bounded linear validation; repeated-group regexes overflow on multi-MB files. */
export function decodeBase64Bounded(value: unknown, limit = 30 * 1024 * 1024): Buffer {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length % 4 ||
    value.length > Math.ceil(limit / 3) * 4
  )
    throw Error('文件内容无效或超过30MB')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0,
    end = value.length - padding,
    bytes = (value.length / 4) * 3 - padding
  if (bytes > limit) throw Error('文件内容超过允许大小')
  for (let i = 0; i < end; i++) {
    const c = value.charCodeAt(i)
    if (
      !(
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 43 ||
        c === 47
      )
    )
      throw Error('文件编码无效')
  }
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
    value[end - 1]
  )
  if ((padding === 2 && last & 15) || (padding === 1 && last & 3)) throw Error('文件填充编码无效')
  const data = Buffer.from(value, 'base64')
  if (data.length !== bytes) throw Error('文件内容不完整')
  return data
}
