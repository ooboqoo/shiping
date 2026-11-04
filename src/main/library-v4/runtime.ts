import { request, embed } from '../rag/client'
import { EMBED_MODEL, OLLAMA_URL, CHUNK_VERSION } from '../../shared/rag'
export { request, embed }
let cached: { digest: string; value: string } | undefined
const pending = new Map<string, Promise<string>>()
export async function fingerprint(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const tags = await request<{ models: { name: string; digest: string }[] }>(
      OLLAMA_URL + '/api/tags',
      undefined,
      signal
    ),
    model = tags.models.find((m) => m.name === EMBED_MODEL || m.name === EMBED_MODEL + ':latest')
  if (!model) throw Error('本地BGE-M3模型未安装')
  if (cached?.digest === model.digest) return cached.value
  let task = pending.get(model.digest)
  if (!task) {
    task = embed(['向量索引兼容性检查'], signal)
      .then((v) => {
        const value = `${EMBED_MODEL}:${model.digest}:${v[0].length}:${CHUNK_VERSION}`
        cached = { digest: model.digest, value }
        return value
      })
      .finally(() => pending.delete(model.digest))
    pending.set(model.digest, task)
  }
  const result = await task
  signal?.throwIfAborted()
  return result
}
