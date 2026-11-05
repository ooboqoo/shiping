import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { settings, screenshotSaveDir } from './settings'

function generateFilename(): string {
  const now = new Date()
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}_${time}.png`
}

export async function saveScreenshotToDisk(base64Data: string): Promise<void> {
  if (!settings.screenshotAutoSave) return

  const dir = screenshotSaveDir()
  try {
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, generateFilename())
    const buffer = Buffer.from(base64Data, 'base64')
    await writeFile(filePath, buffer)
  } catch (error) {
    console.error('Failed to save screenshot:', error)
  }
}
