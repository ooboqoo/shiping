export async function extractPdfPages(
  pdf: any,
  ocr: (page: number) => Promise<string>
): Promise<string> {
  if (pdf.numPages > 150) throw Error('PDF 超过150页，请拆分文件')
  const pages: string[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n),
      content = await page.getTextContent()
    const text = content.items
      .map((x: any) => ('str' in x ? x.str + (x.hasEOL ? '\n' : ' ') : ''))
      .join('')
      .trim()
    const useOcr = !/[\p{L}\p{N}]/u.test(text)
    pages.push(`# 第 ${n} 页${useOcr ? '（OCR）' : ''}\n${useOcr ? await ocr(n) : text}`)
    page.cleanup?.()
  }
  return pages.join('\n\n')
}
