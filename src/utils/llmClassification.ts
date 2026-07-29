import { chatWithLlm, type LlmStreamListener } from '../api/llm'
import type { ClassificationAgentConfig } from '../types/llmExamples'
import type { LabelLayoutTemplate } from './labelTemplates'
import type { PdfPageImage } from './pdfPageImages'

export interface PageClassification {
  isTarget: boolean
  confidence: number
  reason: string
  raw: string
}

const DEFAULT_CLASSIFICATION_SYSTEM =
  '你是单证页面快速分类器。只判断页面是否属于目标版式，不抽取字段。只输出 JSON。'

export function parseClassification(raw: string): PageClassification {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const parsed = JSON.parse(
    start >= 0 && end > start ? raw.slice(start, end + 1) : raw,
  ) as Record<string, unknown>
  const confidence =
    typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5
  return {
    isTarget: parsed.is_target === true || parsed.is_target === 'true',
    confidence,
    reason:
      typeof parsed.reason === 'string' ? parsed.reason : '模型未提供判定理由',
    raw,
  }
}

export function shouldSkipPage(
  classification: PageClassification,
  threshold: number,
): boolean {
  return !classification.isTarget && classification.confidence >= threshold
}

export async function classifyPageWithLlm(params: {
  image: PdfPageImage
  template: LabelLayoutTemplate
  agent: ClassificationAgentConfig
  signal?: AbortSignal
  onStream?: LlmStreamListener
}): Promise<PageClassification> {
  const model = params.agent.model?.trim()
  if (!model) throw new Error('分类智能体未配置 model')

  const fields = [
    ...params.template.headerFields.map((item) => `${item.key}: ${item.label}`),
    ...params.template.sublistColumns.map((item) => `${item.key}: ${item.label}`),
  ]
  const hints =
    params.agent.hints && params.agent.hints.length > 0
      ? params.agent.hints.map((item) => `- ${item}`).join('\n')
      : '- 根据目标字段标题、版式和单证类型判断'

  const raw = await chatWithLlm(
    {
      model,
      stream: true,
      think: false,
      format: 'json',
      options: {
        temperature: 0,
        num_predict: 256,
        num_ctx: 4096,
      },
      messages: [
        {
          role: 'system',
          content: params.agent.systemPrompt?.trim() || DEFAULT_CLASSIFICATION_SYSTEM,
        },
        {
          role: 'user',
          content:
            `目标版式：${params.template.name}\n目标字段：\n${fields.join('\n')}\n` +
            `分类智能体总结的判定特征：\n${hints}\n\n` +
            '输出 {"is_target":true或false,"confidence":0到1,"reason":"简短理由"}。' +
            '无法确定时 confidence 必须低于 0.8，以便进入高清抽取。',
          images: [params.image.base64],
        },
      ],
    },
    params.signal,
    'classify',
    params.onStream,
  )
  try {
    return parseClassification(raw)
  } catch {
    return {
      isTarget: true,
      confidence: 0,
      reason: '预判结果无法解析，已安全回退到高清抽取',
      raw,
    }
  }
}
