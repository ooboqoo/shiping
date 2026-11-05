import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useSettingsStore, type AppMode } from './store/settings'
import { useAppStore } from './store/app'
import { thinkingTag } from './api-profiles'

export const MODE_PATHS: Record<AppMode, string> = {
  screenshot: '/',
  conversation: '/conversation'
}

export const MODE_NAMES: Record<AppMode, string> = {
  screenshot: '截图模式',
  conversation: '对话模式'
}

export const otherMode = (mode: AppMode): AppMode =>
  mode === 'screenshot' ? 'conversation' : 'screenshot'

/**
 * What both mode pages do alike: tell main which page is up, apply the window
 * opacity, and answer the shortcuts that act on "the current mode" — its AI
 * profile, its prompt scene, and switching to the other mode.
 */
export function useModePage(mode: AppMode): void {
  const navigate = useNavigate()
  const opacity = useSettingsStore((state) => state.opacity)
  const syncAppState = useAppStore((state) => state.syncAppState)

  useEffect(() => {
    document.body.style.opacity = opacity.toString()
    return () => {
      document.body.style.opacity = ''
    }
  }, [opacity])

  // The next start opens where the user left off
  useEffect(() => {
    useSettingsStore.getState().updateSetting('lastMode', mode)
  }, [mode])

  useEffect(() => {
    const key = mode === 'screenshot' ? 'inCoderPage' : 'inConversationPage'
    window.api.updateAppState({ [key]: true })
    return () => {
      window.api.updateAppState({ [key]: false })
    }
  }, [mode])

  useEffect(() => {
    window.api.onSyncAppState((state) => syncAppState(state))
    return () => {
      window.api.removeSyncAppStateListener()
    }
  }, [syncAppState])

  useEffect(() => {
    window.api.onAdjustOpacity((delta) => {
      useSettingsStore.getState().adjustOpacity(delta)
    })
    return () => {
      window.api.removeAdjustOpacityListener()
    }
  }, [])

  useEffect(() => {
    window.api.onSwitchApiProfile((direction) => {
      const profile = useSettingsStore.getState().cycleProfile(mode, direction)
      if (!profile) {
        toast(mode === 'screenshot' ? '没有其他能识图的配置可以切换' : '只有一个配置，无法切换')
        return
      }
      toast(`${MODE_NAMES[mode]}已切换到「${profile.name}」`, {
        description: [profile.model || '未设置模型', thinkingTag(profile)]
          .filter(Boolean)
          .join(' · '),
        duration: 3000
      })
    })
    return () => {
      window.api.removeSwitchApiProfileListener()
    }
  }, [mode])

  useEffect(() => {
    window.api.onCycleScene(() => {
      const name = useSettingsStore.getState().cycleScene(mode)
      if (!name) return
      // An answer already streaming keeps the prompt it started with
      toast(`已切换到「${name}」`, { description: '下次提问生效', duration: 3000 })
    })
    return () => {
      window.api.removeCycleSceneListener()
    }
  }, [mode])

  // Main already resent the request without the switch; this only explains why
  // the answer may be slower than the setting promises
  useEffect(() => {
    window.api.onThinkingUnsupported((model) => {
      toast('当前模型不支持关闭思考，已按默认方式请求', {
        description: `${model}：可在设置里关掉这个配置的「关闭思考」`,
        duration: 5000
      })
    })
    return () => {
      window.api.removeThinkingUnsupportedListener()
    }
  }, [])

  // Same for 「思考强度」: the request already went again without it
  useEffect(() => {
    window.api.onReasoningEffortUnsupported((model) => {
      toast('当前模型不支持调节思考强度，已按默认方式请求', {
        description: `${model}：可在设置里把这个配置的「思考强度」改回默认`,
        duration: 5000
      })
    })
    return () => {
      window.api.removeReasoningEffortUnsupportedListener()
    }
  }, [])

  // The answer goes on without the passages; this says why it may know less
  useEffect(() => {
    window.api.onExternalKnowledgeError((message) => {
      toast(message, { description: '可在「设置 → 资料库 → 外部知识库」测试连接', duration: 4000 })
    })
    return () => {
      window.api.removeExternalKnowledgeErrorListener()
    }
  }, [])

  useEffect(() => {
    window.api.onSwitchMode(() => navigate(MODE_PATHS[otherMode(mode)]))
    return () => {
      window.api.removeSwitchModeListener()
    }
  }, [mode, navigate])
}
