import { useEffect, useRef, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  ArrowLeft,
  Bot,
  Camera,
  HelpCircle,
  Keyboard,
  LibraryBig,
  MessagesSquare,
  Mic,
  Network,
  Palette,
  Smartphone,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/lib/store/settings'
import { useAppStore } from '@/lib/store/app'
import { MODE_PATHS } from '@/lib/use-mode-page'
import { AiModelsSection } from './sections/AiModelsSection'
import { VoiceSection } from './sections/VoiceSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { ShortcutsSection } from './sections/ShortcutsSection'
import { ScreenshotSection } from './sections/ScreenshotSection'
import { ConversationSection } from './sections/ConversationSection'
import { KnowledgeSection } from './sections/KnowledgeSection'
import { MobileSection } from './sections/MobileSection'
import { NetworkSection } from './sections/NetworkSection'
import { ScrollPanel } from '@/components/ScrollPanel'

type Tab =
  | 'ai'
  | 'network'
  | 'knowledge'
  | 'voice'
  | 'appearance'
  | 'mobile'
  | 'shortcuts'
  | 'screenshot'
  | 'conversation'

/**
 * Grouped by what a setting affects: the shared ones first, then one group per
 * mode. The mode pages open their own group (`?tab=screenshot`).
 */
const NAV: { heading: string; items: { tab: Tab; label: string; Icon: LucideIcon }[] }[] = [
  {
    heading: '通用',
    items: [
      { tab: 'ai', label: 'AI 模型', Icon: Bot },
      { tab: 'network', label: '网络代理', Icon: Network },
      { tab: 'knowledge', label: '资料库', Icon: LibraryBig },
      { tab: 'voice', label: '语音', Icon: Mic },
      { tab: 'appearance', label: '界面与隐私', Icon: Palette },
      { tab: 'mobile', label: '手机同步', Icon: Smartphone },
      { tab: 'shortcuts', label: '快捷键', Icon: Keyboard }
    ]
  },
  {
    heading: '模式',
    items: [
      { tab: 'screenshot', label: '截图模式', Icon: Camera },
      { tab: 'conversation', label: '对话模式', Icon: MessagesSquare }
    ]
  }
]

const TABS = NAV.flatMap((group) => group.items.map((item) => item.tab))

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tab') as Tab | null
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'ai'
  const lastMode = useSettingsStore((state) => state.lastMode)
  const setActiveProfile = useSettingsStore((state) => state.setActiveProfile)
  const syncAppState = useAppStore((state) => state.syncAppState)
  const contentRef = useRef<HTMLDivElement>(null)

  const openTab = (next: Tab) => setSearchParams({ tab: next }, { replace: true })
  // From a mode's profile picker: open that profile in the AI 模型 group
  const editProfile = (id: string) => {
    setActiveProfile(id)
    openTab('ai')
  }

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [tab])

  /**
   * Click-through is suspended while this page is up — the switch that turns
   * it back off lives here, so letting it apply would swallow the very clicks
   * needed to undo it. Main keeps the preference and applies it on the way out,
   * so the switch still reflects what the user chose.
   */
  useEffect(() => {
    window.api.updateAppState({ inSettingsPage: true })
    return () => {
      window.api.updateAppState({ inSettingsPage: false })
    }
  }, [])

  useEffect(() => {
    window.api.onSyncAppState((state) => syncAppState(state))
    return () => {
      window.api.removeSyncAppStateListener()
    }
  }, [syncAppState])

  useEffect(() => {
    return () => {
      document.body.style.opacity = ''
    }
  }, [])

  const sections: Record<Tab, ReactNode> = {
    ai: <AiModelsSection />,
    network: <NetworkSection />,
    knowledge: <KnowledgeSection />,
    voice: <VoiceSection />,
    appearance: <AppearanceSection />,
    mobile: <MobileSection />,
    shortcuts: <ShortcutsSection />,
    screenshot: (
      <ScreenshotSection onEditProfile={editProfile} onOpenKnowledge={() => openTab('knowledge')} />
    ),
    conversation: (
      <ConversationSection
        onEditProfile={editProfile}
        onOpenVoice={() => openTab('voice')}
        onOpenKnowledge={() => openTab('knowledge')}
      />
    )
  }

  return (
    <>
      {/* Header */}
      <div id="app-header" className="flex items-center">
        <div className="actions">
          <Button variant="ghost" asChild size="icon" className="w-12 mr-2 rounded-none">
            <Link to={MODE_PATHS[lastMode]}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
        </div>
        <h1>设置</h1>
      </div>

      {/* The page itself never scrolls: the nav stays put, the content scrolls */}
      <div id="app-content" className="flex" style={{ overflow: 'hidden' }}>
        <ScrollPanel
          className="w-36 shrink-0 border-r border-black/10 max-[640px]:w-12"
          contentClassName="p-2"
        >
          <nav className="flex flex-col gap-0.5">
            {NAV.map((group) => (
              <div key={group.heading} className="flex flex-col gap-0.5">
                <div className="px-3 pt-3 pb-1 text-xs opacity-60 select-none max-[640px]:hidden">
                  {group.heading}
                </div>
                {group.items.map(({ tab: itemTab, label, Icon }) => (
                  <button
                    key={itemTab}
                    aria-label={label}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors cursor-pointer select-none max-[640px]:justify-center max-[640px]:px-0',
                      itemTab === tab ? 'bg-gray-300/80 font-medium' : 'hover:bg-gray-300/40'
                    )}
                    onClick={() => openTab(itemTab)}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate max-[640px]:hidden">{label}</span>
                  </button>
                ))}
              </div>
            ))}
            <div className="mt-2 border-t border-black/10 pt-2">
              {/* The help page's own way in, for when the title bar's button is hidden */}
              <Link
                to="/help"
                state={{ from: `/settings?tab=${tab}` }}
                aria-label="帮助"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors select-none hover:bg-gray-300/40 max-[640px]:justify-center max-[640px]:px-0"
              >
                <HelpCircle className="h-4 w-4 shrink-0" />
                <span className="truncate max-[640px]:hidden">帮助</span>
              </Link>
            </div>
          </nav>
        </ScrollPanel>
        <ScrollPanel
          viewportRef={contentRef}
          className="min-w-0 flex-1"
          contentClassName="flex flex-col gap-4 p-3"
        >
          {sections[tab]}
        </ScrollPanel>
      </div>
    </>
  )
}
