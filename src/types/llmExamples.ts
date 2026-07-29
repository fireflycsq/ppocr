import type { DocumentCategory, TargetStructureType } from './labeling'

export interface ExampleAnswer {
  category: DocumentCategory
  structureType?: TargetStructureType
  fields?: Record<string, string>
  invoices?: Array<Record<string, string>>
  invoicesWithSublist?: Array<{
    invoice: Record<string, string>
    sublist: Array<Record<string, string>>
  }>
  invoice?: Record<string, string>
  sublist?: Array<Record<string, string>>
  [key: string]: unknown
}

export interface LlmExample {
  id: number
  layout_template_id: string
  file_name: string
  file_size: number
  /** 旧数据可能缺失，按文件名后缀推断 */
  media_type?: 'pdf' | 'image'
  category: DocumentCategory
  answer: ExampleAnswer
  created_by: number
  created_by_username: string
  created_at: string
  pdf_url: string
}

export function resolveExampleMediaType(example: LlmExample): 'pdf' | 'image' {
  if (example.media_type) return example.media_type
  return example.file_name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image'
}

export interface PromptOptimization {
  /** 抽取智能体（可选）：写入大模型请求 JSON 的 system / user；样例优化默认不再生成 */
  systemPrompt?: string
  userPrompt?: string
  /** 分类智能体：低清预判用的特征与可选 system 提示 */
  classificationHints: string[]
  classificationSystemPrompt?: string
  /** 为空则与抽取共用 requestJson 中的 model */
  classificationModel?: string
  examplesRevision: string
  optimizedAt: string
}

/** 运行时传给分类智能体的配置 */
export interface ClassificationAgentConfig {
  hints?: string[]
  systemPrompt?: string
  model?: string
}
