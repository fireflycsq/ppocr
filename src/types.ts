export interface OcrBox {
  /** 四边形顶点坐标 [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] */
  box: [number, number][]
  text: string
  confidence?: number
  layout_type?: string
}

export interface OcrPageResult {
  pageIndex: number
  results: OcrBox[]
  width?: number
  height?: number
  previewImageUrl?: string
  thumbnailUrl?: string
}

export interface OcrResult {
  image?: string
  results: OcrBox[]
  engine?: string
  width?: number
  height?: number
  extractedText?: string
  taskId?: string
  isPdf?: boolean
  pageCount?: number
  /** PDF 多页识别结果 */
  pages?: OcrPageResult[]
  /** 单页图片预览（非多页 PDF） */
  previewImageUrl?: string
}

export interface FieldDefinition {
  id: string
  key: string
  label: string
}

export type FieldStatus = 'pending' | 'adopted' | 'rejected'

export interface AdoptedField {
  key: string
  label: string
  value: string
  status: FieldStatus
  /** 采纳时关联的 OCR 框索引，-1 表示手动输入 */
  sourceIndex: number
  /** 采纳时关联的 PDF 页码，从 0 开始 */
  sourcePageIndex?: number
  confidence?: number
}

export type WorkflowStep = 'upload' | 'review'

export interface ExportPayload {
  exportedAt: string
  sourceFile?: string
  ocrEngine?: string
  fields: Record<string, string>
  adopted: AdoptedField[]
  rejected: AdoptedField[]
  ocrRaw: OcrBox[]
  pages?: OcrPageResult[]
}
