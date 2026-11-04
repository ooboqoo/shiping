import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Library } from './repository'
/** Opt-in activation marker. Missing marker keeps legacy compatibility; invalid marker fails closed. */
export function openActiveLibrary(dataRoot: string): Library | undefined {
  const dir = join(dataRoot, 'library'),
    marker = join(dir, 'active.json')
  if (!existsSync(marker)) return undefined
  const config = JSON.parse(readFileSync(marker, 'utf8'))
  if (config.version !== 1 || config.database !== 'shiping.sqlite') throw Error('资料数据库配置无效')
  const file = join(dir, 'shiping.sqlite')
  if (!existsSync(file)) throw Error('资料数据库缺失，请恢复备份，不能回退创建空库')
  return new Library(file)
}
