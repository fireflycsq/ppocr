import JSON5 from 'json5'
import type { FieldDefinition } from '../types'
import type { LabelLayoutTemplate } from './labelTemplates'

/**
 * Qwen3-VL（Ollama）抽取配置：requestJson 是发给 Ollama /api/chat 的完整请求体，
 * 可在前端整体编辑（模型、提示词、options、messages 结构都在其中）
 */
export interface LlmExtractionConfig {
  requestJson: string
}

export const DEFAULT_LLM_MODEL = 'qwen3-vl'

/** 请求 JSON 中的页图片占位符，发送时替换为当页 base64 */
export const PAGE_IMAGE_PLACEHOLDER = '{{PAGE_IMAGE}}'

const STORAGE_PREFIX = 'ppocr-llm-extraction-config:'

const DEFAULT_SYSTEM_PROMPT = [
  '你是专业的单证信息抽取助手，负责从发票、运单等单证的页面图片中抽取结构化字段。',
  '你必须只输出一个合法的 JSON 对象，禁止输出任何解释、注释或 Markdown 代码块。',
  '所有字段值一律输出字符串；图片中未出现的字段直接省略，不要编造。',
  '只根据当前页图片抽取，禁止复述、循环输出或抄写样例/历史答案中的具体字段值。',
  '整页只输出一次 JSON，完成后立即停止，不要重复输出相同结构。',
].join('\n')

function fieldLines(fields: FieldDefinition[]): string {
  return fields.map((field) => `- ${field.key}：${field.label}`).join('\n')
}

/** 根据版式的字段配置生成默认的抽取提示词 */
export function buildDefaultUserPrompt(template: LabelLayoutTemplate): string {
  const hasSublist = template.sublistColumns.length > 0
  const lines: string[] = [
    '这是一份单证 PDF 中的一页。请先判断该页是否包含下述目标字段，再按要求抽取。',
    '',
    '发票头字段（header，每张发票一组）：',
    fieldLines(template.headerFields),
  ]

  if (hasSublist) {
    lines.push(
      '',
      '子清单明细列（sublist，一行对应一条明细）：',
      fieldLines(template.sublistColumns),
    )
  }

  lines.push(
    '',
    '请严格按以下 JSON 结构输出：',
    '{',
    '  "is_target": true 或 false，该页是否包含上述目标字段。封面、合同条款、报关随附资料、空白页等无关页填 false,',
    '  "invoices": [该页上出现发票头的每张发票一个对象：',
    '    {"header": {字段key: "字符串值"（未出现的字段省略）}' +
      (hasSublist ? ',' : '}],'),
  )

  if (hasSublist) {
    lines.push(
      '     "sublist": [{列key: "字符串值"}, ...]（该发票在本页的明细行，没有则为空数组）}],',
      '  "orphan_sublist": [{列key: "字符串值"}, ...]（该页只有明细行、发票头出现在之前页时放这里，否则为空数组）',
    )
  } else {
    lines.push('  "orphan_sublist": []')
  }

  lines.push(
    '}',
    '',
    '注意：',
    '- is_target 为 false 时，invoices 与 orphan_sublist 都输出空数组',
    '- 金额只保留数字、小数点与负号；日期、编号保持原文',
    '- 表格明细逐行抽取，不要合并、不要遗漏行',
    '- 只输出 JSON 本身',
  )

  if (template.id === 'air_waybill') {
    lines.push(
      '',
      '目标页判定：必须含空中运输单编号（Air Waybill Number）或运单明细行；',
      '仅有发票号码、发票日期的首页封面/汇总页 is_target=false。',
    )
  }

  return lines.join('\n')
}

interface RequestJsonParts {
  model?: string
  systemPrompt?: string
  userPrompt?: string
  options?: Record<string, unknown>
}

function buildRequestJsonText(
  template: LabelLayoutTemplate,
  parts: RequestJsonParts = {},
): string {
  const body = {
    model: parts.model ?? DEFAULT_LLM_MODEL,
    stream: true,
    think: false,
    format: 'json',
    options: parts.options ?? {
      temperature: 0,
      num_ctx: 8192,
      num_predict: 4096,
    },
    messages: [
      { role: 'system', content: parts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: parts.userPrompt ?? buildDefaultUserPrompt(template),
        images: [PAGE_IMAGE_PLACEHOLDER],
      },
    ],
  }
  return formatRequestJsonText(body)
}

/** 编辑态：content 用 ''' 多行块，解析前还原为标准 JSON 字符串 */
function preprocessContentBlocks(text: string): string {
  return text.replace(
    /("content"\s*:\s*)'''([\s\S]*?)'''/g,
    (_match, prefix: string, raw: string) => {
      const normalized = raw.replace(/^\n/, '').replace(/\n$/, '')
      return `${prefix}${JSON.stringify(normalized)}`
    },
  )
}

function formatEditableString(key: string, value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (key === 'content' && normalized.includes('\n')) {
    return `'''\n${normalized}\n'''`
  }
  return JSON.stringify(value)
}

function formatEditableValue(key: string | null, value: unknown, indent: string): string {
  if (typeof value === 'string') {
    return formatEditableString(key ?? '', value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inner = value
      .map((item, index) => {
        const formatted = formatEditableValue(null, item, `${indent}  `)
        const comma = index < value.length - 1 ? ',' : ''
        return `${indent}  ${formatted}${comma}`
      })
      .join('\n')
    return `[\n${inner}\n${indent}]`
  }
  if (value !== null && typeof value === 'object') {
    return formatRequestJsonObject(value as Record<string, unknown>, indent)
  }
  return JSON.stringify(value)
}

function formatRequestJsonObject(
  obj: Record<string, unknown>,
  indent: string,
): string {
  const keys = Object.keys(obj)
  if (keys.length === 0) return '{}'
  const inner = keys
    .map((key, index) => {
      const comma = index < keys.length - 1 ? ',' : ''
      const value = obj[key]
      const formatted =
        typeof value === 'string'
          ? formatEditableString(key, value)
          : formatEditableValue(key, value, `${indent}  `)
      return `${indent}  ${JSON.stringify(key)}: ${formatted}${comma}`
    })
    .join('\n')
  return `{\n${inner}\n${indent}}`
}

/** 格式化完整请求 JSON；messages 里的 content 保留真实换行，便于对照 API 写法编辑 */
export function formatRequestJsonText(body: Record<string, unknown>): string {
  return formatRequestJsonObject(body, '')
}

export function buildDefaultLlmConfig(
  template: LabelLayoutTemplate,
): LlmExtractionConfig {
  return { requestJson: buildRequestJsonText(template) }
}

/** 修正 Qwen3-VL 常见误配：think 耗尽 num_predict 导致 content 为空 */
export function normalizeOllamaChatBody(
  body: Record<string, unknown>,
  profile: 'extract' | 'classify' = 'extract',
): Record<string, unknown> {
  const rawOpts = body.options
  const options: Record<string, unknown> =
    typeof rawOpts === 'object' && rawOpts !== null && !Array.isArray(rawOpts)
      ? { ...(rawOpts as Record<string, unknown>) }
      : {}
  delete options.think

  if (profile === 'extract') {
    const minPredict = 1024
    const numPredict = options.num_predict
    if (typeof numPredict !== 'number' || numPredict < minPredict) {
      options.num_predict = 4096
    }
    if (typeof options.num_ctx !== 'number') {
      options.num_ctx = 8192
    }
    if (options.temperature === undefined) {
      options.temperature = 0
    }
    if (options.repeat_penalty === undefined) {
      options.repeat_penalty = 1.12
    }
  }

  return { ...body, think: false, options }
}

function migrateLoadedRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return sanitizeExtractMessages(normalizeOllamaChatBody(body, 'extract'))
}

/** 兼容旧版分字段存储（model/systemPrompt/userPrompt/optionsJson）的迁移 */
interface StoredLlmConfig {
  requestJson?: string
  model?: string
  systemPrompt?: string
  userPrompt?: string
  optionsJson?: string
}

export function loadLlmConfig(template: LabelLayoutTemplate): LlmExtractionConfig {
  const raw = localStorage.getItem(`${STORAGE_PREFIX}${template.id}`)
  if (!raw) return buildDefaultLlmConfig(template)

  try {
    const stored = JSON.parse(raw) as StoredLlmConfig
    if (stored.requestJson?.trim()) {
      const loaded = parseRequestJson(stored.requestJson)
      if (loaded.body) {
        const migrated = migrateLoadedRequestBody(loaded.body)
        return { requestJson: formatRequestJsonText(migrated) }
      }
      return { requestJson: stored.requestJson }
    }
    // 旧版结构：拼装为完整请求 JSON
    let options: Record<string, unknown> | undefined
    if (stored.optionsJson) {
      try {
        const parsed = JSON.parse(stored.optionsJson)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          options = parsed as Record<string, unknown>
        }
      } catch {
        options = undefined
      }
    }
    return {
      requestJson: buildRequestJsonText(template, {
        model: stored.model,
        systemPrompt: stored.systemPrompt,
        userPrompt: stored.userPrompt,
        options,
      }),
    }
  } catch {
    return buildDefaultLlmConfig(template)
  }
}

export function saveLlmConfig(templateId: string, config: LlmExtractionConfig) {
  localStorage.setItem(`${STORAGE_PREFIX}${templateId}`, JSON.stringify(config))
}

export function clearLlmConfig(templateId: string) {
  localStorage.removeItem(`${STORAGE_PREFIX}${templateId}`)
}

export interface ParsedRequestJson {
  body: Record<string, unknown> | null
  model: string
  error: string | null
}

function jsonParseErrorMessage(err: unknown, text: string): string {
  const base =
    '不是合法 JSON。请使用英文逗号 ,、双引号包裹键名，options 示例：{"temperature": 0, "num_ctx": 8192}'
  if (!(err instanceof SyntaxError)) return base
  const posMatch = err.message.match(/position (\d+)/i)
  if (!posMatch) return `${base}（${err.message}）`
  const pos = Number(posMatch[1])
  const line = text.slice(0, pos).split('\n').length
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  const col = pos - lineStart + 1
  return `${base}（约第 ${line} 行第 ${col} 列：${err.message}）`
}

/** 解析 JSON，并自动去掉对象/数组末尾多余逗号（常见手误） */
export function parseJsonLenient(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let current = preprocessContentBlocks(text.trim())
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return { ok: true, value: JSON.parse(current) }
    } catch (jsonErr) {
      try {
        return { ok: true, value: JSON5.parse(current) }
      } catch {
        const fixed = current.replace(/,\s*([}\]])/g, '$1')
        if (fixed !== current) {
          current = fixed
          continue
        }
        return { ok: false, error: jsonParseErrorMessage(jsonErr, text) }
      }
    }
  }
  return { ok: false, error: jsonParseErrorMessage(new SyntaxError(''), text) }
}

export interface ParsedOptionsJson {
  options: Record<string, unknown> | null
  error: string | null
}

/** 只解析 options 对象（不含外层 request 壳） */
export function parseOptionsJson(text: string): ParsedOptionsJson {
  const trimmed = text.trim()
  if (!trimmed) {
    return { options: {}, error: null }
  }
  const parsed = parseJsonLenient(trimmed)
  if (!parsed.ok) {
    return { options: null, error: parsed.error }
  }
  if (
    typeof parsed.value !== 'object' ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  ) {
    return {
      options: null,
      error: 'options 必须是一个 JSON 对象，例如 {"temperature": 0, "num_ctx": 8192}',
    }
  }
  return { options: parsed.value as Record<string, unknown>, error: null }
}

/** 在完整请求 JSON 中替换 options，避免手改大段 messages 时误伤引号 */
export function mergeRequestJsonOptions(
  requestJson: string,
  options: Record<string, unknown>,
): { requestJson: string; error: null } | { requestJson: null; error: string } {
  const { body, error } = parseRequestJson(requestJson)
  if (!body || error) {
    return {
      requestJson: null,
      error:
        error ??
        '整段请求 JSON 已有语法错误，请先修复上方内容或点「恢复当前版式默认配置」',
    }
  }
  return {
    requestJson: formatRequestJsonText({ ...body, options }),
    error: null,
  }
}

/** 校验请求 JSON：必须是对象，包含 model 与 messages 数组 */
export function parseRequestJson(text: string): ParsedRequestJson {
  const trimmed = text.trim()
  if (!trimmed) {
    return { body: null, model: '', error: '请求 JSON 不能为空' }
  }

  const parsedResult = parseJsonLenient(trimmed)
  if (!parsedResult.ok) {
    return { body: null, model: '', error: parsedResult.error }
  }
  const parsed = parsedResult.value

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { body: null, model: '', error: '请求 JSON 需要是一个对象' }
  }

  const body = parsed as Record<string, unknown>
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) {
    return { body: null, model: '', error: '缺少 "model" 字段（Ollama 模型名）' }
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { body: null, model, error: '缺少 "messages" 数组（对话消息）' }
  }

  return { body, model, error: null }
}

/**
 * 抽取请求只保留 system + 最后一条 user，去掉误写入的 few-shot / assistant 轮次，
 * 避免模型在流式输出中复读样例 JSON。
 */
export function sanitizeExtractMessages(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const rawMessages = body.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return body

  const messages = rawMessages.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  )
  const systemMsg = messages.find((item) => item.role === 'system')
  let lastUser: Record<string, unknown> | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUser = messages[index]
      break
    }
  }
  if (!lastUser) return body

  const sanitized: Record<string, unknown>[] = []
  if (systemMsg) sanitized.push({ ...systemMsg })
  sanitized.push({ ...lastUser })
  return { ...body, messages: sanitized }
}

function replacePlaceholder(value: unknown, imageBase64: string): {
  value: unknown
  replaced: boolean
} {
  if (typeof value === 'string') {
    if (value === PAGE_IMAGE_PLACEHOLDER) return { value: imageBase64, replaced: true }
    return { value, replaced: false }
  }
  if (Array.isArray(value)) {
    let replaced = false
    const next = value.map((item) => {
      const result = replacePlaceholder(item, imageBase64)
      replaced = replaced || result.replaced
      return result.value
    })
    return { value: next, replaced }
  }
  if (typeof value === 'object' && value !== null) {
    let replaced = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const result = replacePlaceholder(item, imageBase64)
      replaced = replaced || result.replaced
      next[key] = result.value
    }
    return { value: next, replaced }
  }
  return { value, replaced: false }
}

/**
 * 用当页图片构造实际请求体：
 * 将 {{PAGE_IMAGE}} 占位符替换为 base64；若没有占位符则追加到最后一条消息的 images。
 * stream 由 api/llm.ts 统一强制为 true（流式保活，避免 nginx 502）。
 */
export function buildPageRequestBody(
  requestJson: string,
  imageBase64: string,
): Record<string, unknown> {
  const { body, error } = parseRequestJson(requestJson)
  if (!body || error) throw new Error(error ?? '请求 JSON 无效')

  const sanitized = sanitizeExtractMessages(body)
  const { value, replaced } = replacePlaceholder(sanitized, imageBase64)
  const result = normalizeOllamaChatBody(value as Record<string, unknown>, 'extract')

  if (!replaced) {
    const messages = result.messages as Array<Record<string, unknown>>
    const last = messages[messages.length - 1]
    const images = Array.isArray(last.images) ? last.images : []
    last.images = [...images, imageBase64]
  }

  result.stream = true
  return result
}
