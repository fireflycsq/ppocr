import { chatWithLlm, formatLlmStreamText, type LlmStreamSnapshot } from '../api/llm'
import { downloadLlmExampleFile } from '../api/examples'
import type { ClassificationAgentConfig, LlmExample, PromptOptimization } from '../types/llmExamples'
import { resolveExampleMediaType } from '../types/llmExamples'
import type { LabelLayoutTemplate } from './labelTemplates'
import { formatRequestJsonText, parseRequestJson, sanitizeExtractMessages } from './llmConfig'
import { renderImageFileToBase64, renderPdfPagesToImages } from './pdfPageImages'

const OPTIMIZATION_PREFIX = 'ppocr-prompt-optimization:'

/** 分类智能体：样例更少、分辨率更低，专注目标/非目标区分 */
const CLASSIFY_MAX_EXAMPLES = 4
const CLASSIFY_MAX_PAGES = 1
const CLASSIFY_MAX_DIMENSION = 512

interface OptimizeContext {
  examples: LlmExample[]
  template: LabelLayoutTemplate
  model: string
  signal?: AbortSignal
  onStream?: (snapshot: LlmStreamSnapshot) => void
}

export interface PromptOptimizeStreamUpdate {
  label: string
  text: string
}

export function examplesRevision(examples: LlmExample[]): string {
  return examples
    .map((item) => `${item.id}:${item.created_at}`)
    .sort()
    .join('|')
}

export function loadPromptOptimization(
  templateId: string,
): PromptOptimization | null {
  const raw = localStorage.getItem(`${OPTIMIZATION_PREFIX}${templateId}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PromptOptimization
  } catch {
    return null
  }
}

export function savePromptOptimization(
  templateId: string,
  optimization: PromptOptimization,
): void {
  localStorage.setItem(
    `${OPTIMIZATION_PREFIX}${templateId}`,
    JSON.stringify(optimization),
  )
}

export function clearPromptOptimization(templateId: string): void {
  localStorage.removeItem(`${OPTIMIZATION_PREFIX}${templateId}`)
}

function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = (fenced?.[1] ?? text).trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  const parsed = JSON.parse(
    start >= 0 && end > start ? source.slice(start, end + 1) : source,
  ) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('提示词优化结果不是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function templateDescription(template: LabelLayoutTemplate): string {
  return JSON.stringify(
    {
      id: template.id,
      name: template.name,
      headerFields: template.headerFields.map(({ key, label }) => ({ key, label })),
      sublistColumns: template.sublistColumns.map(({ key, label }) => ({
        key,
        label,
      })),
      classificationRules: template.classificationRules ?? [],
    },
    null,
    2,
  )
}

function parseModelContext(requestJson: string): { model: string } {
  const { body, model, error } = parseRequestJson(requestJson)
  if (!body || error) throw new Error(error ?? '大模型请求配置无效')
  return { model }
}

function classificationLabel(example: LlmExample): Record<string, unknown> {
  return {
    category: example.category,
    is_target: example.category === 'target',
  }
}

async function loadExampleImages(
  example: LlmExample,
  options: { maxDimension: number; pageLimit: number },
): Promise<string[]> {
  const file = await downloadLlmExampleFile(example)
  const mediaType = resolveExampleMediaType(example)
  if (mediaType === 'image') {
    return [
      await renderImageFileToBase64(file, {
        maxDimension: options.maxDimension,
        jpegQuality: 0.58,
      }),
    ]
  }
  const pages = await renderPdfPagesToImages(file, undefined, {
    maxDimension: options.maxDimension,
    jpegQuality: 0.58,
    pageLimit: options.pageLimit,
  })
  return pages.map((image) => image.base64)
}

async function appendExampleTurns(
  messages: Array<Record<string, unknown>>,
  examples: LlmExample[],
  imageOptions: { maxDimension: number; pageLimit: number },
  answerForExample: (example: LlmExample) => Record<string, unknown>,
): Promise<void> {
  for (const example of examples) {
    const images = await loadExampleImages(example, imageOptions)
    messages.push({
      role: 'user',
      content: `样例 ${example.file_name}，类别：${example.category}`,
      images,
    })
    messages.push({
      role: 'assistant',
      content: JSON.stringify(answerForExample(example)),
    })
  }
}

/** 分类智能体：总结低清预判可用的版式/排除特征 */
async function optimizeClassificationAgent(
  ctx: OptimizeContext,
): Promise<Pick<
  PromptOptimization,
  'classificationHints' | 'classificationSystemPrompt' | 'classificationModel'
>> {
  const examples = ctx.examples.slice(0, CLASSIFY_MAX_EXAMPLES)
  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content:
        '你是单证页面分类提示词工程师。根据版式与样例缩略图，总结在低分辨率下仍可识别的目标版式特征与非目标排除特征。只输出 JSON。',
    },
    {
      role: 'user',
      content:
        `目标版式：\n${templateDescription(ctx.template)}\n` +
        '下面提供目标/非目标样例各若干。只需学习「是否属于该版式」，不需要字段值。\n' +
        (ctx.template.classificationRules?.length
          ? `版式判定规则（生成的 hints 不得违背）：\n${ctx.template.classificationRules.map((item) => `- ${item}`).join('\n')}`
          : ''),
    },
  ]

  await appendExampleTurns(
    messages,
    examples,
    { maxDimension: CLASSIFY_MAX_DIMENSION, pageLimit: CLASSIFY_MAX_PAGES },
    classificationLabel,
  )

  messages.push({
    role: 'user',
    content:
      '请输出 {"classification_system_prompt":"...","classification_hints":["..."],"classification_model":""}。' +
      'classification_system_prompt 用于低清页级分类（只判 is_target，不抽字段）；' +
      'classification_hints 每条应是低分辨率下可观察的标题、版式、关键字或排除特征；' +
      '必须体现版式判定规则：含运单编号/明细才是目标，仅发票号+日期多为封面应排除；' +
      'classification_model 留空表示与抽取共用同一模型，也可建议更小的视觉模型名。',
  })

  const raw = await chatWithLlm(
    {
      model: ctx.model,
      stream: true,
      think: false,
      format: 'json',
      options: {
        temperature: 0.1,
        num_predict: 512,
        num_ctx: 4096,
        repeat_penalty: 1.15,
      },
      messages,
    },
    ctx.signal,
    'optimize',
    (snapshot) => ctx.onStream?.(snapshot),
  )

  const parsed = extractJsonObject(raw)
  const classificationSystemPrompt =
    typeof parsed.classification_system_prompt === 'string'
      ? parsed.classification_system_prompt.trim()
      : typeof parsed.system_prompt === 'string'
        ? parsed.system_prompt.trim()
        : undefined
  const classificationHints = Array.isArray(parsed.classification_hints)
    ? parsed.classification_hints.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
    : []
  const classificationModel =
    typeof parsed.classification_model === 'string' &&
    parsed.classification_model.trim().length > 0
      ? parsed.classification_model.trim()
      : undefined

  if (classificationHints.length === 0 && !classificationSystemPrompt) {
    throw new Error('分类智能体未返回 classification_hints 或 classification_system_prompt')
  }

  return {
    classificationHints,
    classificationSystemPrompt,
    classificationModel,
  }
}

/**
 * 根据样例优化低清预判用的分类特征（只判 is_target，不改抽取提示词）。
 */
export async function optimizePromptFromExamples(params: {
  examples: LlmExample[]
  template: LabelLayoutTemplate
  requestJson: string
  signal?: AbortSignal
  onStreamUpdate?: (event: PromptOptimizeStreamUpdate) => void
}): Promise<PromptOptimization> {
  if (params.examples.length === 0) {
    throw new Error('当前版式没有可用于优化的样例')
  }

  const { model } = parseModelContext(params.requestJson)
  const ctx: OptimizeContext = {
    examples: params.examples,
    template: params.template,
    model,
    signal: params.signal,
    onStream: (snapshot) => {
      params.onStreamUpdate?.({
        label: '正在根据样例学习目标/非目标判定特征…',
        text: formatLlmStreamText(snapshot, { preferCompleteJson: true }),
      })
    },
  }

  const classification = await optimizeClassificationAgent(ctx)

  return {
    ...classification,
    examplesRevision: examplesRevision(params.examples),
    optimizedAt: new Date().toISOString(),
  }
}

export function applyPromptOptimization(
  requestJson: string,
  optimization: PromptOptimization,
): string {
  if (!optimization.systemPrompt?.trim() || !optimization.userPrompt?.trim()) {
    return requestJson
  }
  const { body, error } = parseRequestJson(requestJson)
  if (!body || error) throw new Error(error ?? '大模型请求配置无效')
  const sanitized = sanitizeExtractMessages(body)
  const messages = (sanitized.messages as Array<Record<string, unknown>>).map(
    (item) => ({ ...item }),
  )
  const systemIndex = messages.findIndex((item) => item.role === 'system')
  if (systemIndex >= 0) {
    messages[systemIndex].content = optimization.systemPrompt
  } else {
    messages.unshift({ role: 'system', content: optimization.systemPrompt })
  }
  const userIndex = messages.findIndex((item) => item.role === 'user')
  if (userIndex < 0) throw new Error('请求配置缺少 user 消息')
  messages[userIndex].content = optimization.userPrompt
  return formatRequestJsonText({ ...sanitized, messages })
}

export function buildClassificationAgentConfig(
  optimization: PromptOptimization | null | undefined,
  fallbackModel: string,
): ClassificationAgentConfig {
  if (!optimization) {
    return { model: fallbackModel }
  }
  return {
    hints: optimization.classificationHints,
    systemPrompt: optimization.classificationSystemPrompt,
    model: optimization.classificationModel || fallbackModel,
  }
}
