/** Explicit preparation only. Document recognition never downloads resources. */
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  https = require('node:https')
const root = path.join(__dirname, '../resources/ocr')
// Tesseract language data, distributed by the official tesseract.js-data repository.
const languages = ['eng', 'chi_sim']
const hashes = {
  eng: 'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468',
  chi_sim: '59388039851e4d1293d729c183fd8c1fa9bbbb959eed996e945024671e68c1d6'
}
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (redirects > 5) return reject(Error('下载重定向过多'))
        return resolve(download(new URL(res.headers.location, url).href, redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(Error(`下载失败 ${res.statusCode}`))
      }
      const parts = []
      let size = 0
      res.on('data', (b) => {
        size += b.length
        if (size > 40 * 1024 * 1024) req.destroy(Error('语言文件超过上限'))
        else parts.push(b)
      })
      res.on('end', () => resolve(Buffer.concat(parts)))
      res.on('error', reject)
    })
    req.setTimeout(60000, () => req.destroy(Error('下载超时')))
    req.on('error', reject)
  })
}
;(async () => {
  await fs.mkdir(root, { recursive: true })
  const entries = []
  for (const lang of languages) {
    const file = path.join(root, lang + '.traineddata.gz'),
      url = `https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/${lang}.traineddata.gz`
    let data = await fs.readFile(file).catch(() => null)
    if (!data) {
      data = await download(url)
      if (data[0] !== 0x1f || data[1] !== 0x8b) throw Error('语言资源格式无效')
      await fs.writeFile(file + '.tmp', data)
      await fs.rename(file + '.tmp', file)
    }
    if (crypto.createHash('sha256').update(data).digest('hex') !== hashes[lang])
      throw Error(`${lang} 资源校验失败，请移走该文件后重新准备`)
    entries.push({
      language: lang,
      url,
      bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex')
    })
    console.log(`${lang}: ${data.length} bytes`)
  }
  await fs.writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ engine: 'tesseract.js 6.0.1', entries }, null, 2) + '\n'
  )
  await fs.copyFile(path.join(__dirname, '../node_modules/tesseract.js/LICENSE.md'), path.join(root, 'LICENSE-Apache-2.0.txt'))
  await fs.writeFile(path.join(root, 'NOTICE.txt'), 'Tesseract language data: https://github.com/naptha/tessdata\nSource: https://github.com/tesseract-ocr/tessdata\nLicense: Apache-2.0. Upstream notices and ownership retained.\n')
  console.log('OCR 资源已准备，本地识别不再联网。')
})().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
