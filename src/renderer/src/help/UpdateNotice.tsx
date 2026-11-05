import { Download, ExternalLink, LoaderCircle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/lib/store/app'
import type { AvailableUpdate } from '../../../shared/update'

/** A newer release: installed in place on Windows, downloaded from its page on macOS */
export function UpdateNotice() {
  const update = useAppStore((state) => state.update)
  if (!update) return null

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-emerald-600/50 bg-emerald-600/10 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="font-semibold">
          发现新版本 v{update.version}
          <a
            href={update.url}
            target="_blank"
            rel="noreferrer"
            className="ml-2 text-sm font-normal text-blue-600 hover:underline"
          >
            查看更新内容
          </a>
        </h3>
        <p className="text-sm break-words text-gray-700">{describe(update)}</p>
        <p className="text-sm break-words text-amber-900">
          新版本可能改变隐身效果，升级后需要依赖隐身模式时，请先重新实际测试一遍。
        </p>
      </div>
      <UpdateAction update={update} />
    </div>
  )
}

function describe(update: AvailableUpdate): string {
  if (!update.installable) {
    return '到发布页下载 dmg，把应用拖入「应用程序」替换旧版即可，设置和资料都会保留。替换后如果截图或语音不能用，到「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」里删掉本应用，再重新添加。'
  }
  switch (update.phase) {
    case 'available':
      return '下载完成后重启即可安装，设置和资料都会保留。'
    case 'downloading':
      return `正在下载… ${update.percent ?? 0}%`
    case 'downloaded':
      return '已下载完成，重启后安装；也可以稍后再装，退出应用时会自动安装。'
    case 'failed':
      return `下载失败：${update.error ?? '未知错误'}。可以重试，或到发布页手动下载安装包。`
  }
}

function UpdateAction({ update }: { update: AvailableUpdate }) {
  if (!update.installable) {
    return (
      <Button asChild size="sm">
        <a href={update.url} target="_blank" rel="noreferrer">
          <ExternalLink />
          前往下载
        </a>
      </Button>
    )
  }
  switch (update.phase) {
    case 'available':
      return (
        <Button size="sm" onClick={() => window.api.downloadUpdate()}>
          <Download />
          下载更新
        </Button>
      )
    case 'downloading':
      return (
        <Button size="sm" disabled>
          <LoaderCircle className="animate-spin" />
          下载中
        </Button>
      )
    case 'downloaded':
      return (
        <Button size="sm" onClick={() => window.api.installUpdate()}>
          <RotateCw />
          重启并安装
        </Button>
      )
    case 'failed':
      return (
        <Button size="sm" onClick={() => window.api.downloadUpdate()}>
          <Download />
          重试
        </Button>
      )
  }
}
