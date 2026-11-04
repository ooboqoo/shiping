import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
let selected: string | undefined
export function selectedLibrary(): string {
  if (selected === undefined) {
    try { selected = JSON.parse(readFileSync(join(app.getPath('userData'), 'selected-library.json'), 'utf8')).id } catch {}
    selected ||= 'shiping'
  }
  return selected
}
export function selectLibrary(id: string) {
  writeFileSync(join(app.getPath('userData'), 'selected-library.json'), JSON.stringify({id}), {mode: 0o600})
  selected = id
}
