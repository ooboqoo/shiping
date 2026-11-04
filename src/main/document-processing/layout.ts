import type { Element } from '../../shared/document-processing'
/** Conservative position ordering. Ambiguous layouts still require review. */
export function orderElements(elements: Element[], columns: boolean): Element[] {
  if (elements.some((e) => !e.bbox)) return elements
  const spatial = (a: Element, b: Element) =>
    Math.abs(a.bbox![1] - b.bbox![1]) < 0.008 ? a.bbox![0] - b.bbox![0] : a.bbox![1] - b.bbox![1]
  if (!columns) return [...elements].sort(spatial)
  const separators = elements.filter((e) => e.bbox![0] < 0.45 && e.bbox![2] > 0.55).sort(spatial)
  const remaining = elements.filter((e) => !separators.includes(e)),
    output: Element[] = []
  const band = (upper: number) => {
    const selected = remaining.filter((e) => e.bbox![1] < upper)
    const left = selected.filter((e) => e.bbox![0] < 0.5),
      right = selected.filter((e) => e.bbox![0] >= 0.5)
    output.push(...left.sort(spatial), ...right.sort(spatial))
    for (const e of selected) remaining.splice(remaining.indexOf(e), 1)
  }
  for (const separator of separators) {
    band(separator.bbox![1])
    output.push(separator)
  }
  band(Infinity)
  return output
}
