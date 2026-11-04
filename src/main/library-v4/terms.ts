/** Identical document/query terms; Chinese single characters and bigrams, intact technical terms. */
export function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_+#.-]+|[\u3400-\u9fff]+/g) || []
  return words.flatMap((w) =>
    /^[\u3400-\u9fff]/.test(w)
      ? [...w, ...Array.from({ length: Math.max(0, w.length - 1) }, (_, i) => w.slice(i, i + 2))]
      : [w]
  )
}
export function frequencies(text: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const term of tokens(text)) map.set(term, (map.get(term) || 0) + 1)
  return map
}
