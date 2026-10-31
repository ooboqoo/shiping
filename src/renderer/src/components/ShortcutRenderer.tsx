import { cn } from '@renderer/lib/utils'
import { getShortcutAcceleratorDisplay } from '@/lib/utils/keyboard'

export default function ShortcutRenderer({
  shortcut,
  className
}: {
  shortcut: string
  className?: string
}) {
  // Cleared in the settings: the action has no key
  const keys = shortcut ? getShortcutAcceleratorDisplay(shortcut).split('+') : ['未设置']
  return (
    <span
      className={cn(
        'text-sm font-semibold rounded transition-colors bg-gray-200 hover:bg-gray-300 py-1 px-2 space-x-1',
        className
      )}
    >
      {keys.map((key) => (
        <span key={key}>{key}</span>
      ))}
    </span>
  )
}
