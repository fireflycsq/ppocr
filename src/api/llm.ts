import { normalizeOllamaChatBody } from '../utils/llmConfig'

/** nginx 将 /api/llm/ 转发到 Ollama 根路径 */
const LLM_BASE = '/api/llm'

export interface LlmHealth {
  ready: boolean
  models: string[]
  error: string | null
}

export async function checkLlmHealth(): Promise<LlmHealth> {
  try {
    const res = await fetch(`${LLM_BASE}/api/tags`)
    if (!res.ok) {
      return { ready: false, models: [], error: `Ollama 服务不可用（${res.status}）` }
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> }
    const models = (data.models ?? [])
      .map((m) => m.name ?? '')
      .filter((name) => name.length > 0)
    return { ready: true, models, error: null }
  } catch {
    return { ready: false, models: [], error: '无法连接 Ollama 服务' }
  }
}

/** 模型对单页的原始抽取输出（已按约定 schema 归一化） */
export interface RawPageInvoice {
  header: Record<string, unknown>
  sublist: Array<Record<string, unknown>>
}

export interface RawPageExtraction {
  isTarget: boolean
  invoices: RawPageInvoice[]
  orphanSublist: Array<Record<string, unknown>>
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string; thinking?: string }
  error?: string
  done?: boolean
}

/** 去掉模型可能输出的 Markdown 代码围栏，再截取首尾大括号之间的内容 */
function extractJsonText(content: string): string {
  let text = content.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1)
  }
  return text
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.map(asRecord).filter((item) => Object.keys(item).length > 0)
}

function normalizeExtraction(parsed: unknown): RawPageExtraction {
  const root = asRecord(parsed)
  const invoicesRaw = Array.isArray(root.invoices) ? root.invoices : []
  return {
    isTarget: root.is_target === true || root.is_target === 'true',
    invoices: invoicesRaw.map((item) => {
      const record = asRecord(item)
      return {
        header: asRecord(record.header),
        sublist: asRecordArray(record.sublist),
      }
    }),
    orphanSublist: asRecordArray(root.orphan_sublist),
  }
}

/** 携带模型原始输出的错误，便于页面展示排查 */
export class LlmOutputError extends Error {
  rawContent?: string

  constructor(message: string, rawContent?: string) {
    super(message)
    this.name = 'LlmOutputError'
    this.rawContent = rawContent
  }
}

export interface LlmPageResponse {
  extraction: RawPageExtraction
  /** 模型返回的原始文本，用于逐页排查 */
  rawContent: string
}

async function readErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text.trim()) {
    return statusHint(res.status)
  }
  try {
    const data = JSON.parse(text) as { error?: string; detail?: string }
    if (data.error) return data.error
    if (data.detail) return data.detail
  } catch {
    // nginx 502/504 常返回 HTML
  }
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160)
  return `${statusHint(res.status)}${snippet ? `：${snippet}` : ''}`
}

function statusHint(status: number): string {
  if (status === 502) {
    return (
      'Ollama 上游连接失败（502）。通常是 ppocr-web 容器无法访问 Ollama，而非推理超时。' +
      '请确认：① 宿主机已运行 ollama serve；② Ollama 监听 0.0.0.0（OLLAMA_HOST=0.0.0.0:11434）；' +
      '③ .env 中 LLM_UPSTREAM 正确（容器内 Ollama 填 <容器名>:11434）；' +
      '④ docker logs ppocr-web 查看启动时 Ollama 连通性检测'
    )
  }
  if (status === 504) {
    return 'Ollama 网关超时（504）。单页推理时间过长，请确认已重建 frontend（超时 30 分钟）或缩小图片/换更小模型'
  }
  return `Ollama 请求失败（${status}）`
}

interface ChatStreamResult {
  content: string
  thinking: string
}

export interface LlmStreamSnapshot {
  content: string
  thinking: string
}

export type LlmStreamListener = (snapshot: LlmStreamSnapshot) => void

export interface LlmStreamOptions {
  /** 返回 true 时提前结束流式读取（已得到完整可用 JSON） */
  stopWhen?: (snapshot: LlmStreamSnapshot) => boolean
}

/** 流式预览：优先 content，否则展示 thinking；抽取场景下若已拼出完整 JSON 则只展示该 JSON */
export function formatLlmStreamText(
  snapshot: LlmStreamSnapshot,
  options?: { preferCompleteJson?: boolean },
): string {
  const raw = snapshot.content.trim()
    ? snapshot.content
    : snapshot.thinking.trim()
      ? `【思考过程】\n${snapshot.thinking}`
      : ''
  if (!options?.preferCompleteJson || !snapshot.content.trim()) return raw
  const candidate = extractJsonText(snapshot.content)
  try {
    JSON.parse(candidate)
    return candidate
  } catch {
    return snapshot.content
  }
}

function appendStreamDelta(accumulated: string, delta: string): string {
  if (!delta) return accumulated
  if (
    accumulated.length > 0 &&
    delta.length >= accumulated.length &&
    delta.startsWith(accumulated)
  ) {
    return delta
  }
  return accumulated + delta
}

function isCompleteExtractJson(text: string): boolean {
  const candidate = extractJsonText(text.trim())
  if (!candidate.startsWith('{')) return false
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    return 'is_target' in parsed || Array.isArray(parsed.invoices)
  } catch {
    return false
  }
}

function isCompleteClassificationJson(text: string): boolean {
  const candidate = extractJsonText(text.trim())
  if (!candidate.startsWith('{')) return false
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    return 'is_target' in parsed && typeof parsed.confidence === 'number'
  } catch {
    return false
  }
}

function isCompleteOptimizeJson(text: string): boolean {
  const candidate = extractJsonText(text.trim())
  if (!candidate.startsWith('{')) return false
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    const hasClassification =
      Array.isArray(parsed.classification_hints) ||
      typeof parsed.classification_system_prompt === 'string'
    const hasExtraction =
      typeof parsed.system_prompt === 'string' && typeof parsed.user_prompt === 'string'
    return hasClassification || hasExtraction
  } catch {
    return false
  }
}

function resolveStreamStopWhen(
  profile: 'extract' | 'classify' | 'optimize',
): LlmStreamOptions['stopWhen'] | undefined {
  if (profile === 'extract') {
    return (snapshot) => isCompleteExtractJson(snapshot.content)
  }
  if (profile === 'classify') {
    return (snapshot) => isCompleteClassificationJson(snapshot.content)
  }
  if (profile === 'optimize') {
    return (snapshot) => isCompleteOptimizeJson(snapshot.content)
  }
  return undefined
}

/** 读取 Ollama NDJSON 流，拼接 assistant content/thinking */
async function readChatStream(
  res: Response,
  signal?: AbortSignal,
  onStream?: LlmStreamListener,
  options?: LlmStreamOptions,
): Promise<ChatStreamResult> {
  if (!res.body) {
    const data = (await res.json()) as OllamaChatResponse
    if (data.error) throw new Error(data.error)
    const snapshot = {
      content: data.message?.content ?? '',
      thinking: data.message?.thinking ?? '',
    }
    onStream?.(snapshot)
    return snapshot
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let thinking = ''
  let streamError: string | null = null

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined)
      throw new DOMException('已中断', 'AbortError')
    }
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let chunk: OllamaChatResponse
      try {
        chunk = JSON.parse(trimmed) as OllamaChatResponse
      } catch {
        continue
      }
      if (chunk.error) {
        streamError = chunk.error
        break
      }
      if (chunk.message?.content) {
        content = appendStreamDelta(content, chunk.message.content)
      }
      if (chunk.message?.thinking) {
        thinking = appendStreamDelta(thinking, chunk.message.thinking)
      }
      const snapshot = { content, thinking }
      onStream?.(snapshot)
      if (options?.stopWhen?.(snapshot)) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
    if (streamError) break
  }

  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer.trim()) as OllamaChatResponse
      if (chunk.error) streamError = chunk.error
      else {
        if (chunk.message?.content) {
          content = appendStreamDelta(content, chunk.message.content)
        }
        if (chunk.message?.thinking) {
          thinking = appendStreamDelta(thinking, chunk.message.thinking)
        }
        const snapshot = { content, thinking }
        onStream?.(snapshot)
      }
    } catch {
      // ignore trailing incomplete line
    }
  }

  if (streamError) throw new Error(streamError)
  return { content, thinking }
}

function sanitizeChatRequest(
  body: Record<string, unknown>,
  profile: 'extract' | 'classify' | 'optimize',
): Record<string, unknown> {
  if (profile === 'classify') {
    const rawOpts = body.options
    const opts =
      typeof rawOpts === 'object' && rawOpts !== null && !Array.isArray(rawOpts)
        ? { ...(rawOpts as Record<string, unknown>) }
        : {}
    delete opts.think
    const numPredict =
      typeof opts.num_predict === 'number' ? opts.num_predict : 256
    return {
      ...body,
      think: false,
      stream: true,
      options: {
        temperature: 0,
        num_ctx: 4096,
        ...opts,
        num_predict: Math.max(numPredict, 256),
      },
    }
  }

  if (profile === 'optimize') {
    const rawOpts = body.options
    const opts =
      typeof rawOpts === 'object' && rawOpts !== null && !Array.isArray(rawOpts)
        ? { ...(rawOpts as Record<string, unknown>) }
        : {}
    delete opts.think
    const numPredict =
      typeof opts.num_predict === 'number' ? opts.num_predict : 512
    return {
      ...body,
      think: false,
      stream: true,
      format: body.format ?? 'json',
      options: {
        temperature: 0.1,
        num_ctx: 4096,
        repeat_penalty: 1.15,
        ...opts,
        num_predict: Math.min(Math.max(numPredict, 256), 768),
      },
    }
  }

  const normalized = normalizeOllamaChatBody({ ...body, stream: true }, 'extract')
  return normalized
}

/** Qwen3-VL 偶发 think:false 时仍只填 thinking；若其中有合法 JSON 则回退使用 */
function tryRecoverJsonFromThinking(thinking: string): string | null {
  const candidate = extractJsonText(thinking.trim())
  if (!candidate.startsWith('{')) return null
  try {
    JSON.parse(candidate)
    return candidate
  } catch {
    return null
  }
}

function resolveModelText(content: string, thinking: string): string {
  if (content.trim()) return content
  return tryRecoverJsonFromThinking(thinking) ?? content
}

/** 通用 Ollama 流式 chat；提示词优化、分类和抽取共用同一传输逻辑。 */
export async function chatWithLlm(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  profile: 'extract' | 'classify' | 'optimize' = 'extract',
  onStream?: LlmStreamListener,
  streamOptions?: LlmStreamOptions,
): Promise<string> {
  const requestBody = sanitizeChatRequest(body, profile)
  const stopWhen = streamOptions?.stopWhen ?? resolveStreamStopWhen(profile)

  let res: Response
  try {
    res = await fetch(`${LLM_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new Error(
      err instanceof Error
        ? `无法连接 Ollama 代理：${err.message}`
        : '无法连接 Ollama 代理',
    )
  }

  if (!res.ok) {
    throw new Error(await readErrorDetail(res))
  }

  const { content, thinking } = await readChatStream(res, signal, onStream, {
    stopWhen,
  })
  const resolved = resolveModelText(content, thinking)
  if (!resolved.trim()) {
    if (thinking.trim()) {
      throw new LlmOutputError(
        '模型只返回了思考过程，未生成最终内容。已强制 think:false；请点「恢复当前版式默认配置」或调大 options.num_predict（建议 ≥4096）',
        thinking,
      )
    }
    throw new LlmOutputError(
      '模型未返回内容。请检查模型名称，并删除过小的 options.num_predict 后重试',
    )
  }
  return resolved
}

/**
 * 对单页图片执行一次 Qwen3-VL 抽取（含是否目标页的判定）。
 * body 为已替换页图片占位符的完整 /api/chat 请求体。
 */
export async function extractPageWithLlm(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  onStream?: LlmStreamListener,
): Promise<LlmPageResponse> {
  const content = await chatWithLlm(body, signal, 'extract', onStream)
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonText(content))
  } catch {
    throw new LlmOutputError('模型输出不是合法 JSON，可调整提示词后重试', content)
  }
  return { extraction: normalizeExtraction(parsed), rawContent: content }
}
