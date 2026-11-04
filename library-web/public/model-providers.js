'use strict'
// Unsaved credentials stay in this page session only.
const providerDrafts = new Map()
// Uses the settings page's DOM and authenticated API helpers.
function modelProviderSettings(settings, { el, btn, muted, api, onSaved }) {
  function card(kind, saved) {
    const isEmbed = kind === 'embedding'
    let hasKey = saved.hasApiKey === true
    let dirty = providerDrafts.has(kind)
    let updatedAt = 0
    const provider = el(
      'select',
      { 'aria-label': isEmbed ? 'Embedding 提供商' : 'Rerank 提供商' },
      el('option', { value: '', disabled: true }, '请选择提供商'),
      ...(isEmbed
        ? [
            ['siliconflow', '硅基流动（国内云端 API）'],
            ['aliyun', '阿里云百炼（国内云端 API）'],
            ['openai-compatible', '自定义云端 Embedding（OpenAI 兼容）'],
            ['ollama', '高级：Ollama（外部服务）'],
            ['xinference', '高级：Xinference（外部服务）']
          ]
        : [
            ['siliconflow', '硅基流动（国内云端 API）'],
            ['aliyun', '阿里云百炼（国内云端 API）'],
            ['rerank-compatible', '自定义云端 Rerank（通用格式）'],
            ['xinference', '高级：Xinference（外部服务）']
          ]
      ).map(([value, text]) => el('option', { value }, text))
    )
    provider.value = saved.provider === 'local' ? '' : saved.provider || ''
    const base = el('input', {
      value: saved.baseURL || '',
      placeholder: 'http://127.0.0.1:9997',
      'aria-label': 'Base URL'
    })
    const model = el('input', {
      value: saved.model || '',
      placeholder: '模型名称 / Xinference 模型 UID',
      'aria-label': '模型名称 / UID'
    })
    const key = el('input', {
      type: 'password',
      autocomplete: 'new-password',
      placeholder: hasKey ? '已保存密钥；留空保留' : '可选 API Key',
      'aria-label': 'API Key'
    })
    const clearKey = el('input', {
      type: 'checkbox',
      'aria-label': '清除已保存密钥'
    })
    const timeout = el('input', {
      type: 'number',
      min: 100,
      max: 60000,
      value: saved.timeoutMs || 30000,
      'aria-label': '超时（毫秒）'
    })
    const list = el(
      'select',
      { 'aria-label': '已部署模型列表' },
      el('option', { value: '' }, '获取列表后选择，也可手动填写')
    )
    list.addEventListener('change', () => {
      if (list.value) model.value = list.value
    })
    const status = el('p', { class: 'muted-copy', 'aria-live': 'polite' })
    const field = (label, input) =>
      el('label', { class: 'provider-field' }, el('span', {}, label), input)
    const keyField = field('API Key（可选）', key)
    const clearKeyField = field('清除已保存密钥', clearKey)
    const fields = el(
      'div',
      { class: 'provider-fields' },
      field('Base URL', base),
      field('模型名称 / UID', model),
      keyField,
      field('超时（毫秒）', timeout),
      field('模型列表', list),
      clearKeyField
    )
    const legacyNote = muted('')
    const setupNote = muted(
      '首次使用请在此填写 API Key 并保存模型配置；上传的资料会等待模型配置后建立索引。'
    )
    setupNote.hidden = !isEmbed || saved.configured !== false
    const cloud = () =>
      !!provider.value && !['ollama', 'xinference'].includes(provider.value)
    const link = el(
      'a',
      { target: '_blank', rel: 'noreferrer', class: 'provider-account-link' },
      '开通服务 / 获取 API Key'
    )
    const cloudNote = el(
      'div',
      { class: 'provider-cloud-note' },
      muted(
        '云端 API 需先在平台开通并充值或购买额度。测试、建立索引和检索会调用模型，按平台规则计费；相关文本会发送至所选平台。'
      ),
      link
    )
    const addressNote = muted('')
    function update() {
      fields.hidden = !provider.value
      legacyNote.textContent = !provider.value
        ? '旧本机配置已停用，请选择提供商并保存模型。'
        : ''
      legacyNote.hidden = !!provider.value
      actions.querySelectorAll('button').forEach((b) => {
        b.disabled = !provider.value
      })
      cloudNote.hidden = !cloud()
      keyField.firstChild.textContent = cloud()
        ? 'API Key（必填）'
        : 'API Key（可选）'
      clearKeyField.hidden = cloud()
      link.hidden = !['siliconflow', 'aliyun'].includes(provider.value)
      link.setAttribute(
        'href',
        provider.value === 'aliyun'
          ? 'https://bailian.console.aliyun.com/'
          : 'https://cloud.siliconflow.cn/'
      )
      key.placeholder = hasKey
        ? '已保存密钥；留空保留'
        : cloud()
          ? '必填：平台 API Key'
          : '可选 API Key'
      base.placeholder =
        provider.value === 'aliyun'
          ? 'https://业务空间ID.cn-beijing.maas.aliyuncs.com'
          : cloud()
            ? 'https://你的服务地址/v1'
            : 'http://127.0.0.1:9997'
      addressNote.textContent =
        provider.value === 'aliyun'
          ? '填写百炼控制台提供的国内业务空间服务域名（https://业务空间ID.cn-beijing.maas.aliyuncs.com），需与 API Key 的地域一致。模型列表为推荐项，实际权限以连接测试为准。'
          : cloud()
            ? '填写 API 根地址；自定义 Embedding 使用 /embeddings，通用 Rerank 使用 /rerank。模型列表不可用时可手动填写模型名称。'
            : ''
      list.replaceChildren(
        el('option', { value: '' }, '获取列表后选择，也可手动填写')
      )
    }
    provider.addEventListener('change', () => {
      const presets = {
        ollama: ['http://127.0.0.1:11435', ''],
        xinference: ['http://127.0.0.1:9997', ''],
        siliconflow: [
          'https://api.siliconflow.cn/v1',
          ''
        ],
        aliyun: ['', '']
      }
      const preset = presets[provider.value] || ['', '']
      base.value = preset[0]
      model.value = preset[1]
      key.value = ''
      hasKey = false
      clearKey.checked = false
      key.placeholder = '可选 API Key'
      status.textContent = ''
      update()
      remember()
    })
    function remember() {
      dirty = true
      providerDrafts.set(kind, {
        provider: provider.value,
        base: base.value,
        model: model.value,
        key: key.value,
        clearKey: clearKey.checked,
        timeout: timeout.value,
        hasKey
      })
    }
    for (const input of [base, model, key, clearKey, timeout, list]) {
      input.addEventListener('input', remember)
      input.addEventListener('change', remember)
    }
    const config = () => ({
      provider: provider.value,
      baseURL: base.value.trim(),
      model: model.value.trim(),
      timeoutMs: Number(timeout.value),
      ...(clearKey.checked
        ? { apiKey: '' }
        : key.value
          ? { apiKey: key.value }
          : hasKey
            ? {}
            : { apiKey: '' })
    })
    const actions = el('div', { class: 'provider-actions' })
    async function run(action) {
      if (!provider.value || provider.disabled) return
      updatedAt = Date.now()
      const buttons = [...actions.querySelectorAll('button')]
      const inputs = [...fields.querySelectorAll('input,select')]
      buttons.forEach((b) => {
        b.disabled = true
      })
      inputs.forEach((i) => {
        i.disabled = true
      })
      provider.disabled = true
      status.textContent = '正在处理…'
      try {
        if (action === 'save') {
          const result = await api('/model-providers', 'PUT', {
            kind,
            config: config()
          })
          hasKey = result[kind].hasApiKey
          dirty = false
          providerDrafts.delete(kind)
          setupNote.hidden = !isEmbed || result[kind].configured !== false
          if (onSaved) onSaved(result)
          key.value = ''
          clearKey.checked = false
          key.placeholder = hasKey
            ? '已保存密钥；留空保留'
            : cloud()
              ? '必填：平台 API Key'
              : '可选 API Key'
          status.textContent = isEmbed
            ? '已保存。更换模型后请为各知识库重建索引。'
            : '已保存。请在资料库中启用精排。'
        } else {
          const result = await api('/model-providers', 'POST', {
            kind,
            config: config(),
            action
          })
          if (action === 'models') {
            list.replaceChildren(
              el('option', { value: '' }, '请选择模型'),
              ...result
                .filter(
                  (r) =>
                    !r.type ||
                    r.type.toLowerCase() === (isEmbed ? 'embedding' : 'rerank')
                )
                .map((r) => el('option', { value: r.id }, r.id))
            )
            status.textContent = result.some((r) => r.source === 'preset')
              ? '已加载推荐模型；实际开通状态和权限请通过测试连接确认。'
              : '已获取模型列表；请确认所选模型支持当前任务。'
          } else
            status.textContent = result.dimensions
              ? `连接测试成功，向量维度 ${result.dimensions}`
              : '精排调用测试成功'
        }
      } catch (e) {
        status.textContent = e.message || '操作失败，请重试'
      } finally {
        updatedAt = Date.now()
        buttons.forEach((b) => {
          b.disabled = false
        })
        inputs.forEach((i) => {
          i.disabled = false
        })
        provider.disabled = false
        actions.querySelectorAll('button').forEach((b) => {
          b.disabled = !provider.value
        })
      }
    }
    actions.append(
      btn('获取模型列表', () => run('models')),
      btn('测试连接', () => run('test')),
      btn('保存配置', () => run('save'), 'primary')
    )
    provider.addEventListener('change', () => {
      actions.querySelectorAll('button').forEach((b) => {
        b.disabled = !provider.value
      })
    })
    actions.querySelectorAll('button').forEach((b) => {
      b.disabled = !provider.value
    })
    const cached = providerDrafts.get(kind)
    if (cached) {
      provider.value = cached.provider
      base.value = cached.base
      model.value = cached.model
      key.value = cached.key
      clearKey.checked = cached.clearKey
      timeout.value = cached.timeout
      hasKey = cached.hasKey
      status.textContent = '已修改，尚未保存'
    }
    update()
    const section = el(
      'section',
      { class: 'settings-card provider-settings' },
      el('h2', {}, isEmbed ? 'Embedding 向量模型' : 'Rerank 精排模型'),
      muted(
        isEmbed
          ? '支持国内云端 API 与本机 Ollama、Xinference。更换向量模型、地址或 UID 后需重建索引。'
          : '支持硅基流动、阿里云百炼和兼容 Rerank API，也可使用本机服务。精排失败时保留原检索结果。'
      ),
      legacyNote,
      setupNote,
      field('模型提供商', provider),
      fields,
      addressNote,
      cloudNote,
      actions,
      status
    )
    section.refreshSaved = (next, startedAt = Date.now() + 1) => {
      if (dirty || provider.disabled || startedAt <= updatedAt) return
      setupNote.hidden = !isEmbed || next.configured !== false
      hasKey = next.hasApiKey === true
      provider.value = next.provider === 'local' ? '' : next.provider || ''
      base.value = next.baseURL || ''
      model.value = next.model || ''
      timeout.value = next.timeoutMs || 30000
      update()
    }
    return section
  }
  return [
    card('embedding', settings.embedding),
    card('rerank', settings.rerank)
  ]
}
if (typeof module !== 'undefined') module.exports = { modelProviderSettings }
