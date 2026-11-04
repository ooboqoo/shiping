interface SharedBackend {
  call(method: string, args: unknown[]): Promise<unknown>
}
/** A fixed allowlist: the renderer cannot dispatch arbitrary backend RPC methods. */
export function createModelSettingsHandler(readBackend: () => SharedBackend | undefined) {
  return async (action: string, kind?: string, value?: unknown) => {
    if (!['status', 'save', 'models', 'test', 'rerank-enabled'].includes(action))
      throw Error('模型设置操作无效')
    if (
      action !== 'status' &&
      action !== 'rerank-enabled' &&
      !['embedding', 'rerank'].includes(kind || '')
    )
      throw Error('模型类型无效')
    if (action === 'rerank-enabled' && typeof value !== 'boolean') throw Error('精排开关无效')
    if (
      ['save', 'models', 'test'].includes(action) &&
      (!value || typeof value !== 'object' || Array.isArray(value))
    )
      throw Error('模型配置无效')
    const backend = readBackend()
    if (!backend) throw Error('请先启动本机知识库服务，再配置资料库模型')
    const method = {
      status: 'providerStatus',
      save: 'configureProvider',
      models: 'providerModels',
      test: 'testProvider',
      'rerank-enabled': 'configureRetrieval'
    }[action]!
    return backend.call(
      method,
      action === 'status' ? [] : action === 'rerank-enabled' ? [value] : [kind, value]
    )
  }
}
