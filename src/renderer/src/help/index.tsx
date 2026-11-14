import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import {
  ArrowLeft,
  Lightbulb,
  MessageCircle,
  Camera,
  PictureInPicture2,
  EyeOff,
  Info
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { platformAlt } from '@/lib/utils/env'
import { useSettingsStore } from '@/lib/store/settings'
import { MODE_PATHS } from '@/lib/use-mode-page'
import { HelpSection } from './components'
import { Shortcuts } from './Shortcuts'
import { OverlayToolbarHelp } from './OverlayToolbar'
import { FAQ } from './FAQ'
import { UpdateNotice } from './UpdateNotice'
import { ScrollPanel } from '@/components/ScrollPanel'

export default function HelpPage() {
  const [appVersion, setAppVersion] = useState('')
  const lastMode = useSettingsStore((state) => state.lastMode)
  // Opened from the settings nav: back returns there, else to the mode page
  const from = (useLocation().state as { from?: string } | null)?.from
  const backTo = from?.startsWith('/settings') ? from : MODE_PATHS[lastMode]

  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion)
  }, [])

  return (
    <>
      {/* Header */}
      <div id="app-header" className="flex items-center">
        <div className="actions">
          <Button variant="ghost" asChild size="icon" className="w-12 mr-2 rounded-none">
            <Link to={backTo}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
        </div>
        <h1>帮助中心</h1>
      </div>

      {/* Help Content */}
      <ScrollPanel id="app-content" contentClassName="flex flex-col gap-4 p-8">
        {/* Introduction */}
        <HelpSection Icon={Info} title="简介" description={appVersion && `当前版本 v${appVersion}`}>
          <UpdateNotice />
          <p className="text-gray-700">
            欢迎使用识屏（原「截屏解题助手」）！屏幕上的题目、代码、报错、图表、外文资料，
            按下快捷键截图，AI 就会理解屏幕内容并给出解答。 您可以访问本项目{' '}
            <a
              href="https://github.com/ooboqoo/shiping/wiki"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              GitHub Wiki
            </a>{' '}
            获取更多帮助信息（如安装说明、AI 配置填法、报错排查等）。
          </p>
          <div className="bg-gray-700/10 rounded-lg p-4">
            <h3 className="font-semibold mb-2">主要功能：</h3>
            <ul className="space-y-1 text-gray-700 list-disc list-inside">
              <li className="flex gap-2">
                <Camera className="h-6 w-4" />
                <span>通过快捷键快速截图，并生成解题建议。</span>
              </li>
              <li className="flex gap-2">
                <EyeOff className="h-6 w-4" />
                <span>
                  隐身模式尽量让工具窗口不出现在共享屏幕和录屏里。效果因电脑、系统和会议软件而异，换电脑、升级、换会议软件都可能失效，
                  <strong className="font-semibold">需要依赖它时请每次都自己实际测试</strong>
                  （方法见下方常见问题）。
                </span>
              </li>
              <li className="flex items-start gap-2">
                <PictureInPicture2 className="h-6 w-4" />
                <span>
                  工具窗口置顶半透明显示，您在做题时光标始终停留在做题区域，不会导致原页面失焦。
                </span>
              </li>
            </ul>
          </div>
        </HelpSection>

        {/* Quick Start */}
        <HelpSection Icon={Lightbulb} title="快速开始">
          <div className="border border-gray-400 rounded-lg p-4">
            <h3 className="font-semibold mb-2">1. 截取屏幕截图</h3>
            <p className="text-sm text-gray-700">
              当您需要分析某个问题时，按下快捷键{' '}
              <ShortcutRenderer shortcut={`${platformAlt}+Enter`} className="text-xs mx-1" />
              截取当前屏幕。截图会立即显示在应用中。
            </p>
          </div>
          <div className="border border-gray-400 rounded-lg p-4">
            <h3 className="font-semibold mb-2">2. 查看结果</h3>
            <p className="text-sm text-gray-700">
              截图完成后，系统会根据当前选择的提示词场景自动分析内容，给出解题思路和答案。
            </p>
          </div>
          <div className="border border-gray-400 rounded-lg p-4">
            <h3 className="font-semibold mb-2">3. 语音面试用对话模式</h3>
            <p className="text-sm text-gray-700">
              点窗口顶部的「对话」切换到对话模式，按
              <ShortcutRenderer shortcut={`${platformAlt}+T`} className="text-xs mx-1" />
              开始监听。对方说完一句话，右侧就会给出回答提示；按
              <ShortcutRenderer shortcut={`${platformAlt}+G`} className="text-xs mx-1" />
              可以立即出提示。详见下方常见问题。
            </p>
          </div>
        </HelpSection>

        {/* Keyboard Shortcuts */}
        <Shortcuts />

        {/* Overlay Toolbar */}
        <OverlayToolbarHelp />

        {/* FAQ */}
        <FAQ />

        {/* Contact Support */}
        <HelpSection Icon={MessageCircle} title="联系支持">
          <p className="text-gray-700">如果您遇到问题或有建议，可以通过以下方式获得帮助：</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="border border-gray-400 rounded-lg p-4">
              <h3 className="font-semibold mb-2 ">常见问题排查</h3>
              <p className="text-gray-700">
                在{' '}
                <a
                  href="https://github.com/ooboqoo/shiping/wiki"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  GitHub Wiki
                </a>{' '}
                上按报错或现象查找原因和解决办法
              </p>
            </div>
            <div className="border border-gray-400 rounded-lg p-4">
              <h3 className="font-semibold mb-2 ">GitHub Issues</h3>
              <p className="text-gray-700">
                在{' '}
                <a
                  href="https://github.com/ooboqoo/shiping/issues"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  GitHub Issues
                </a>{' '}
                上提交问题报告和功能请求
              </p>
            </div>
          </div>
        </HelpSection>
      </ScrollPanel>
    </>
  )
}
