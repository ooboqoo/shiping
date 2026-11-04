// Literal identifiers are preserved during query rewriting; they never create retrieval votes.
/** Literal anchors only; no inferred aliases or silent name correction. */
export function queryEntities(query: string): string[] {
  const urls = query.match(/https?:\/\/[^\s<>"，。！？]+/gi) || [],
    words = (
      query
        .replace(/https?:\/\/[^\s<>"，。！？]+/gi, ' ')
        .match(/[a-z][a-z0-9_.+#:-]{1,}|\b[0-9]{3,}\b/gi) || []
    ).filter((w) => /[0-9_.+#:-]/.test(w)),
    people = [...query.matchAll(/([\p{Script=Han}]{2,8})(?:老师|教授|博士|先生|女士)/gu)].map((m) =>
      m[1].replace(/^(?:请问|请教|关于|我想问|想问|这位|那个)/, '')
    )
  return [
    ...new Set(
      [...urls, ...words, ...people]
        .map((s) => s.replace(/[.,;:!?]+$/, ''))
        .filter((s) => s.length >= 2)
    )
  ].slice(0, 12)
}

/** Literal numeric values: keep small chapter numbers and quantities as well as IDs. */
export function numericLiterals(query: string): string[] {
  return [...new Set(query.match(/[+-]?\d+(?:\.\d+)?%?/g) || [])]
}
