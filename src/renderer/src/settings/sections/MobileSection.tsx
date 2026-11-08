import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { toast } from 'sonner'
import { Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useSettingsStore } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { isMac } from '@/lib/utils/env'
import type { MobileLinkState, MobileSyncStatus } from '../../../../shared/mobile'
import { Advanced, Field, SecretInput, SettingsCard } from '../components'

/** Main reports how the sync is doing; read often enough to follow a Wi-Fi switch or a phone joining */
const STATUS_POLL = 2000

const newLanKey = () => crypto.randomUUID().replaceAll('-', '')

function useMobileStatus(): MobileSyncStatus | null {
  const [status, setStatus] = useState<MobileSyncStatus | null>(null)
  useEffect(() => {
    let alive = true
    const read = () =>
      window.api.getMobileStatus().then((next) => {
        if (alive) setStatus(next)
      })
    read()
    const timer = setInterval(read, STATUS_POLL)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return status
}

/**
 * The QR code holds the viewer token, which is as good as the key for reading
 * along. It is safe here only because this window is hidden from screen
 * sharing; never show it anywhere else.
 */
function QrCode({ text }: { text: string }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' }).then(
      (url) => alive && setSrc(url),
      (error) => console.error('Failed to draw the QR code:', error)
    )
    return () => {
      alive = false
    }
  }, [text])
  return src ? <img src={src} alt="" className="h-44 w-44 rounded bg-white" /> : null
}

function ViewerLink({
  url,
  viewers,
  maxViewers
}: {
  url: string
  viewers: number
  maxViewers?: number
}) {
  const full = maxViewers !== undefined && viewers >= maxViewers
  return (
    <div className="flex items-start gap-4">
      <QrCode text={url} />
      <div className="min-w-0 space-y-2 text-xs">
        <div>用手机相机或微信扫码，在浏览器里打开</div>
        <div className="break-all text-gray-600 select-text">{url}</div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              navigator.clipboard.writeText(url).then(
                () => toast('链接已复制，可以发到手机上打开'),
                () => toast.error('复制失败，请手动选中上面的链接复制')
              )
            }
          >
            复制链接
          </Button>
          <span className={full ? 'text-red-700' : 'text-gray-600'}>
            {viewers > 0 ? `${viewers} 台手机在看` : '还没有手机连上'}
            {maxViewers !== undefined && `（上限 ${maxViewers} 台${full ? '，已满' : ''}）`}
          </span>
        </div>
      </div>
    </div>
  )
}

const STATE_TEXT: Record<MobileLinkState, string> = {
  off: '',
  starting: '连接中…',
  on: '已就绪',
  error: '出错'
}

function LinkState({ state, error }: { state: MobileLinkState; error?: string }) {
  if (state === 'off') return null
  return (
    <div className={state === 'error' ? 'text-xs text-red-700' : 'text-xs text-gray-700'}>
      {STATE_TEXT[state]}
      {error && `：${error}`}
    </div>
  )
}

/** With the answer and the hints on the phone, the desktop needs no more than a few buttons */
function MiniBarField() {
  const { shortcuts } = useShortcutsStore()
  const key = shortcuts.toggleMiniBar?.key
  return (
    <Field
      label="极简悬浮条"
      note="主窗口收起，屏幕上只留当前模式的几个按钮（截图 / 出提示、翻页、展开），解答和提示在手机上看；悬浮条和主窗口一样受隐身模式保护（是否生效要自己测试），按住左侧把手可拖动"
    >
      <div className="flex shrink-0 items-center gap-2">
        {key && <ShortcutRenderer shortcut={key} className="text-xs" />}
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.api.triggerAction('toggleMiniBar')}
        >
          收起为悬浮条
        </Button>
      </div>
    </Field>
  )
}

/** What goes wrong in practice, folded so the page stays short */
function Notes() {
  const { shortcuts } = useShortcutsStore()
  const key = (action: string) =>
    shortcuts[action] && (
      <ShortcutRenderer shortcut={shortcuts[action].key} className="mx-1 text-xs" />
    )
  return (
    <Advanced label="使用须知">
      <ul className="list-disc space-y-1.5 pl-4 text-xs text-gray-700">
        <li>
          <b>电脑能打开、手机打不开</b>：多半是防火墙没放行。
          {isMac
            ? '开着 macOS 防火墙时，在「系统设置 → 网络 → 防火墙 → 选项」里允许本应用的传入连接。'
            : 'Windows 按网络类型（专用 / 公用）分别放行，换了 Wi-Fi 可能就不作数了：到「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」，给本应用勾上当前网络那一列。'}
          另外手机不能连访客网络，手机上的代理 / VPN 请先关掉
        </li>
        <li>换了 Wi-Fi，电脑的地址会变，需要重新扫码</li>
        <li>
          电脑上按{key('pageUp')}/{key('pageDown')}翻页，手机跟着翻
        </li>
        <li>
          二维码链接相当于只读密码，别外发；泄露了就点「更换二维码」（公网中转则换服务器密钥）
        </li>
        <li>地址是 http:// 时内容明文传输，在公共 Wi-Fi 上留意</li>
      </ul>
    </Advanced>
  )
}

/** 手机同步: the answers mirrored to a phone, over the LAN or through a public relay */
export function MobileSection() {
  const {
    mobileLanEnabled,
    mobileLanKey,
    mobileRelayEnabled,
    mobileRelayURL,
    mobileRelayKey,
    updateSetting
  } = useSettingsStore()
  const status = useMobileStatus()
  const [addressIndex, setAddressIndex] = useState(0)

  const lanUrls = status?.lan.urls ?? []
  const lanUrl = lanUrls[Math.min(addressIndex, lanUrls.length - 1)]

  return (
    <SettingsCard Icon={Smartphone} title="手机同步">
      <div className="space-y-4">
        <p className="text-xs text-gray-700">
          把截图模式的解答和对话模式的提示实时同步到手机浏览器上，手机只看不操作。二维码扫了就能看，它只显示在本窗口里，靠隐身模式挡在屏幕共享之外；隐身关闭或失效时对方也能扫到，共享屏幕时最好不要打开这一页。
        </p>

        <Field
          label="局域网"
          note={`手机和电脑连同一个 Wi-Fi 即可${isMac ? '' : '；首次开启弹出防火墙提示时请允许'}`}
        >
          <Switch
            className="scale-y-90"
            checked={mobileLanEnabled}
            onCheckedChange={(checked) => {
              if (checked && !mobileLanKey) updateSetting('mobileLanKey', newLanKey())
              updateSetting('mobileLanEnabled', checked)
            }}
          />
        </Field>
        {mobileLanEnabled && status && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-400/70">
            <LinkState state={status.lan.state} error={status.lan.error} />
            {status.lan.state === 'on' && !lanUrl && (
              <div className="text-xs text-red-700">没有找到局域网地址，电脑是否连着网络？</div>
            )}
            {lanUrl && (
              <ViewerLink
                url={lanUrl}
                viewers={status.lan.viewers}
                maxViewers={status.lan.maxViewers}
              />
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {lanUrls.length > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAddressIndex((addressIndex + 1) % lanUrls.length)}
                >
                  扫不开？换一个地址（{(addressIndex % lanUrls.length) + 1}/{lanUrls.length}）
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  updateSetting('mobileLanKey', newLanKey())
                  toast('已更换二维码，之前扫过的手机需要重新扫码')
                }}
              >
                更换二维码
              </Button>
            </div>
          </div>
        )}

        <Field
          label="公网中转"
          note="通过自己的服务器中转，手机用流量也能看；服务器部署见项目 relay/README.md"
        >
          <Switch
            className="scale-y-90"
            checked={mobileRelayEnabled}
            onCheckedChange={(checked) => updateSetting('mobileRelayEnabled', checked)}
          />
        </Field>
        {mobileRelayEnabled && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-400/70">
            <Field label="服务器地址" note="例如 http://1.2.3.4:8787">
              <Input
                className="w-60 shrink-0 bg-white"
                value={mobileRelayURL}
                onChange={(e) => updateSetting('mobileRelayURL', e.target.value)}
                placeholder="http://服务器IP:8787"
              />
            </Field>
            <Field label="密钥" note="与服务器上的 RELAY_KEY 相同">
              <SecretInput
                value={mobileRelayKey}
                onChange={(value) => updateSetting('mobileRelayKey', value)}
                placeholder="RELAY_KEY"
              />
            </Field>
            {status && (
              <>
                <LinkState state={status.relay.state} error={status.relay.error} />
                {status.relay.url && (
                  <ViewerLink
                    url={status.relay.url}
                    viewers={status.relay.viewers}
                    maxViewers={status.relay.maxViewers}
                  />
                )}
              </>
            )}
          </div>
        )}

        <MiniBarField />

        <Notes />
      </div>
    </SettingsCard>
  )
}
