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

const DEFAULT_CLASSIFICATION_SYSTEM = [
  '你是单证页面快速分类器。只判断当前页是否为「可抽取明细的目标页」，不抽取字段值。只输出 JSON。',
  '必须严格遵守版式判定规则：必要条件不满足时 is_target=false，且 confidence 应 ≥0.8 以便跳过后续高清抽取。',
  '仅有发票头等汇总信息、缺少明细关键列的封面页不是目标页。',
].join('\n')

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

function buildClassificationHintBlock(
  template: LabelLayoutTemplate,
  agent: ClassificationAgentConfig,
): string {
  const lines: string[] = []

  if (template.classificationRules?.length) {
    lines.push('【版式判定规则（必须遵守）】')
    lines.push(...template.classificationRules.map((item) => `- ${item}`))
  }

  if (agent.hints && agent.hints.length > 0) {
    lines.push('【样例优化补充特征】')
    lines.push(...agent.hints.map((item) => `- ${item}`))
  } else if (!template.classificationRules?.length) {
    lines.push('- 根据目标字段标题、版式和单证类型判断')
  }

  return lines.join('\n')
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
  const hints = buildClassificationHintBlock(params.template, params.agent)

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
            `目标版式：${params.template.name}\n` +
            `版式字段（供理解，本步不抽取）：\n${fields.join('\n')}\n\n` +
            `${hints}\n\n` +
            '请只根据当前页低清图片判断，输出 {"is_target":true或false,"confidence":0到1,"reason":"简短理由"}。\n' +
            '- 明确不是目标页（如仅发票号/日期的封面汇总页）时：is_target=false 且 confidence≥0.8\n' +
            '- 明确是含运单编号/明细的目标页时：is_target=true\n' +
            '- 图片模糊、无法确认是否含运单编号/明细时：confidence 必须低于 0.8，以便进入高清抽取复核',
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
