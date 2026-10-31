import { BookOpen } from 'lucide-react'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { isMac, platformAlt } from '@/lib/utils/env'
import { HelpSection } from './components'

const faqs = [
  {
    question: '如何截取屏幕截图？',
    answer: (
      <span>
        按下
        <ShortcutRenderer shortcut={`${platformAlt}+Enter`} className="text-xs mx-1" />
        快捷键即可截取当前屏幕的截图。截图会自动显示在应用中。
      </span>
    )
  },
  {
    question: '如何处理题目超过一屏的情况？',
    answer: (
      <span>
        按下
        <ShortcutRenderer shortcut={`${platformAlt}+Shift+Enter`} className="text-xs mx-1" />
        快捷键即可在当前对话中追加截图并生成解题建议。
      </span>
    )
  },
  {
    question: '截图后提示「API 调用失败」，或一直显示正在生成？',
    answer: (
      <span>
        先看报错原文：截图模式在答案区顶部，对话模式在提示卡片上。最常见的原因是「设置 → AI
        模型」里的三项和平台对不上：API Base URL 大多以 /v1 结尾，不要带上 /chat/completions；API
        Key
        要和地址属于同一个平台；模型名按平台文档一字不差地填，截图模式还要选能识图的模型。各种报错的原因和解决办法见{' '}
        <a
          href="https://github.com/ooboqoo/shiping/wiki/AI模型配置与调用失败"
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline"
        >
          GitHub Wiki
        </a>
        。
      </span>
    )
  },
  {
    question: '接了多个显示器，截到的不是题目所在的屏幕？',
    answer: (
      <span>
        默认截取鼠标所在的屏幕，截图前把鼠标移到题目所在的屏幕即可。如果用悬浮工具条截图（点按钮时鼠标在工具条所在的屏幕），或者题目总在同一块屏幕上，可在「设置
        → 截图模式 → 截图屏幕」中指定固定的屏幕。
      </span>
    )
  },
  {
    question: '只想截屏幕上的一块区域（比如题干）？',
    answer: (
      <span>
        在「设置 → 截图模式 → 截图区域」中点「框选区域」，也可以点悬浮工具条上的框选按钮，或按下
        <ShortcutRenderer shortcut={`${platformAlt}+Shift+R`} className="text-xs mx-1" />
        。在定格的屏幕画面上拖出要截的范围，按 Enter
        或双击确认。之后每次截图（包括追加截图）都只截这块区域，AI
        看得更准、响应也更快；题目位置变了随时重新框选，在设置里点「恢复整屏」即可取消。
        注意：框选时本工具会暂时获得焦点，考试页面可能检测到切出，建议在开考前框好。
      </span>
    )
  },
  {
    question: '能像截图工具一样常驻后台，按快捷键随时框选识别吗？',
    answer: (
      <span>
        可以。按
        <ShortcutRenderer shortcut={`${platformAlt}+H`} className="text-xs mx-1" />
        隐藏窗口后应用仍在后台运行，快捷键照常可用（macOS 还可以在「设置 → 界面与隐私」隐藏 Dock
        图标）。需要时按
        <ShortcutRenderer shortcut={`${platformAlt}+Shift+S`} className="text-xs mx-1" />
        ，或单击{isMac ? '屏幕顶部状态栏' : '任务栏右下角托盘'}
        里的识屏图标，在定格的屏幕画面上拖出要识别的范围，松开鼠标就发给
        AI，窗口随即显示出解答。这样框选只截这一次，不改变「截图区域」设置。
      </span>
    )
  },
  {
    question: '分享屏幕时，对方能看到应用吗？',
    answer: (
      <span>
        默认开启「隐身模式」，工具窗口在截图和共享屏幕时隐藏，可在「设置 → 界面与隐私 →
        隐身模式」中关闭，关闭后窗口可被截图和共享。部分会议软件可能需要额外配置，正式使用前请用「当前电脑」+「当前会议软件」测试。相关讨论见{' '}
        <a
          href="https://github.com/ooboqoo/shiping/issues/21"
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline"
        >
          GitHub Issue #21
        </a>
        。
      </span>
    )
  },
  {
    question: '鼠标移过窗口时，光标会不会变？',
    answer: (
      <span>
        本工具提供了开关，可以开启或关闭鼠标穿透。开启鼠标穿透时，窗口对鼠标隐身，你需要通过快捷键来操作窗口。切换「鼠标穿透」开关的快捷键是{' '}
        <ShortcutRenderer shortcut={`${platformAlt}+M`} className="text-xs" />{' '}
        。窗口右下角会显示当前状态。
      </span>
    )
  },
  {
    question: '不想用快捷键，可以用鼠标操作吗？',
    answer: (
      <span>
        可以。主窗口上方的「悬浮工具条」把常用操作做成了按钮，点击即可，且不会让做题页面失焦。
        工具条可在「设置 → 界面与隐私 →
        悬浮工具条」中开启或关闭，各按钮的含义见上方「悬浮工具条」章节。
      </span>
    )
  },
  {
    question: '语音转录功能是什么？如何使用？',
    answer: (
      <span>
        语音转录功能可以实时将面试官的语音或题目朗读转为文字，辅助 AI
        更好地理解题意。使用前需在「设置 → 语音」中配置百炼平台 API Key，然后按下
        <ShortcutRenderer shortcut={`${platformAlt}+T`} className="text-xs mx-1" />
        开始/暂停转录。转录文本会在截图时自动附带提交给 AI。
        如果想根据对方说的话实时出提示、不需要截图，请用「对话模式」。
      </span>
    )
  },
  {
    question: '对话模式是什么？和语音转录有什么区别？',
    answer: (
      <span>
        对话模式专为语音面试设计：左边逐句显示对方（面试官）说的话，右边给出简短的回答提示，全程不截图。
        点窗口顶部的「对话」，或按
        <ShortcutRenderer shortcut={`${platformAlt}+Shift+M`} className="text-xs mx-1" />
        进入，再按
        <ShortcutRenderer shortcut={`${platformAlt}+T`} className="text-xs mx-1" />
        开始监听。默认「自动」出提示：对方说完一句话就立即生成，如果对方其实还没说完，会等说完后重新生成；
        也可以随时按
        <ShortcutRenderer shortcut={`${platformAlt}+G`} className="text-xs mx-1" />
        立即出提示，或按
        <ShortcutRenderer shortcut={`${platformAlt}+Shift+G`} className="text-xs mx-1" />
        切换为「手动」，只在按快捷键时出。对话模式可以单独选用一个 AI 配置，建议选关闭思考的快模型，
        在「设置 → 对话模式」中设置。它采集的是系统音频（会议里对方的声音），自己说话不会触发提示。
      </span>
    )
  },
  {
    question: '能让 AI 参考我的简历或准备好的问答吗？',
    answer: (
      <span>
        可以。在「设置 →
        资料库」导入简历、笔记等文件（PDF、Word、Markdown、TXT），或把准备好的问答直接粘贴成文本。每份资料可以分别选择用于截图模式、对话模式，AI
        作答时会优先参考，经历类问题会结合资料里的项目和数据来答。资料只保存在本机，但会随每次请求一起发给该模式使用的
        AI 平台；资料越多，回答越慢、费用越高，建议每个模式不超过 3 万字。PDF
        提取出的文字可能排版错乱，可以点编辑按钮修正。
      </span>
    )
  },
  {
    question: '能在手机上看答案吗？手机打不开怎么办？',
    answer: (
      <span>
        可以。在「设置 → 手机同步」打开「局域网」，手机连同一个 Wi-Fi
        扫码即可；手机用流量的话用「公网中转」，需要自己的服务器。手机只看不操作，电脑上按
        <ShortcutRenderer shortcut="CommandOrControl+J" className="text-xs mx-1" />/
        <ShortcutRenderer shortcut="CommandOrControl+K" className="text-xs mx-1" />
        翻页时手机跟着翻。电脑能打开、手机打不开，多半是防火墙没放行当前网络（Windows 换了 Wi-Fi
        后常见），也可能是手机连了访客网络或开着 VPN，处理办法见设置页的「使用须知」。
      </span>
    )
  },
  {
    question: '转录的文本可以单独清除吗？',
    answer: (
      <span>
        可以。按下
        <ShortcutRenderer shortcut={`${platformAlt}+Shift+T`} className="text-xs mx-1" />
        即可清除当前转录文本，清除后的文本不会提交给 AI。截图时也会自动清除已有转录文本。
      </span>
    )
  }
]

export function FAQ() {
  return (
    <HelpSection Icon={BookOpen} title="常见问题">
      {faqs.map((faq, index) => (
        <div key={index} className="border border-gray-400 rounded-lg p-4">
          <h3 className="font-semibold mb-2">{faq.question}</h3>
          <p className="text-sm text-gray-700">{faq.answer}</p>
        </div>
      ))}
    </HelpSection>
  )
}
