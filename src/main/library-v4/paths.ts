import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
export function libraryPaths(userData: string) {
  const legacy = join(dirname(userData), 'library')
  const root =
    existsSync(join(legacy, 'v4-active.json')) || existsSync(join(legacy, 'active.json'))
      ? dirname(dirname(legacy))
      : join(userData, 'library-runtime')
  const library = join(root, 'data', 'library')
  return {
    root,
    library,
    discovery: join(library, 'service.json'),
    legacyDocuments: join(userData, 'knowledge')
  }
}
