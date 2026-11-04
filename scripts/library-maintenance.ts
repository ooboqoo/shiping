import { chmodSync } from 'node:fs'
import { prepareV4 } from '../src/main/library-v4/migration'
/** Run only with desktop and admin stopped. No activation occurs during read-only verification. */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { migrateLegacy, snapshotLegacy } from '../src/main/library/migrate'
import { Library } from '../src/main/library/repository'
const [action, inputRoot] = process.argv.slice(2),
  root = resolve(inputRoot || '../local-rag'),
  dir = join(root, 'data/library')
function requireStopped() {
  for (const file of [
    join(root, 'run/admin.json'),
    join(root, 'data/shiping-trial/rag/admin-bridge.json'),
    join(root, 'data/library/service.json'),
    join(root, 'data/library/desktop.json')
  ]) {
    if (!existsSync(file)) continue
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (record.pid) {
      let alive = true
      try {
        process.kill(record.pid, 0)
      } catch {
        alive = false
      }
      if (alive) throw Error('请先退出Shiping并停止管理网页，防止迁移期间写入')
    }
  }
}
async function main() {
  if (!inputRoot) throw Error('必须明确提供local-rag数据根目录')
  if (['verify', 'backup'].includes(action) && !existsSync(join(dir, 'shiping.sqlite')))
    throw Error('正式数据库不存在，禁止创建空库')
  if (action === 'backup') mkdirSync(join(root, 'backups'), { recursive: true, mode: 0o700 })
  if (action === 'upgrade-v4') {
    requireStopped()
    if (existsSync(join(dir, 'v4-active.json'))) throw Error('新版资料库已启用，禁止重复迁移')
    const stamp = Date.now(),
      candidate = join(dir, `v4-candidate-${stamp}.sqlite`),
      ready = join(dir, `v4-ready-${stamp}.sqlite`),
      source = join(dir, 'shiping.sqlite'),
      old = join(dir, `shiping-before-v4-${stamp}.sqlite`)
    const report = await prepareV4(source, candidate, undefined, (message) =>
      console.log(JSON.stringify({ progress: message }))
    )
    const db = new Library(candidate)
    try {
      await db.backup(ready)
    } finally {
      db.close()
    }
    writeFileSync(join(dir, `v4-report-${stamp}.json`), JSON.stringify(report, null, 2), {
      mode: 0o600
    })
    renameSync(source, old)
    try {
      renameSync(ready, source)
      const marker = join(dir, 'v4-active.json')
      writeFileSync(
        marker + '.tmp',
        JSON.stringify({
          version: 1,
          schema: 5,
          activatedAt: new Date().toISOString(),
          previousDatabase: old,
          report: join(dir, `v4-report-${stamp}.json`)
        }),
        { mode: 0o600 }
      )
      renameSync(marker + '.tmp', marker)
    } catch (e) {
      if (existsSync(source)) renameSync(source, candidate + '.failed')
      renameSync(old, source)
      throw e
    }
    chmodSync(source, 0o600)
    console.log(
      JSON.stringify({
        activated: true,
        version: 4,
        documents: report.documents,
        active: report.active,
        trash: report.trash,
        projects: report.projects,
        missingOriginals: report.missingOriginals,
        previousDatabase: old
      })
    )
  } else if (action === 'activate') {
    requireStopped()
    if (existsSync(join(dir, 'active.json')) || existsSync(join(dir, 'shiping.sqlite')))
      throw Error('已有正式数据库或配置，禁止覆盖')
    const stamp = Date.now(),
      snapshot = join(root, 'backups', `before-sqlite-${stamp}`)
    snapshotLegacy(root, snapshot)
    const target = join(dir, `candidate-${stamp}.sqlite`),
      report = migrateLegacy(root, target),
      candidate = new Library(target)
    try {
      await candidate.backup(join(dir, 'shiping.sqlite'))
    } finally {
      candidate.close()
    }
    const marker = join(dir, 'active.json')
    writeFileSync(
      marker + '.tmp',
      JSON.stringify({
        version: 1,
        database: 'shiping.sqlite',
        activatedAt: new Date().toISOString(),
        legacyBackup: snapshot,
        report
      }),
      { mode: 0o600 }
    )
    renameSync(marker + '.tmp', marker)
    console.log(JSON.stringify({ activated: true, report, legacyBackup: snapshot }))
  } else if (action === 'verify') {
    const db = new Library(join(dir, 'shiping.sqlite'))
    try {
      console.log(
        JSON.stringify({
          integrity: db.integrity(),
          projects: db.projects().map((p: any) => ({
            id: p.id,
            active: db.list(p.id).length,
            trash: db.list(p.id, true).length
          }))
        })
      )
    } finally {
      db.close()
    }
  } else if (action === 'backup') {
    const db = new Library(join(dir, 'shiping.sqlite'))
    try {
      const dest = join(root, 'backups', `library-${Date.now()}.sqlite`)
      await db.backup(dest)
      console.log(JSON.stringify({ databaseBackup: dest, assetsNotIncluded: true }))
    } finally {
      db.close()
    }
  } else throw Error('Use activate|upgrade-v4|verify|backup <local-rag root>')
}
main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
