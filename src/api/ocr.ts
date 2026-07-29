import type { OcrBox, OcrPageResult, OcrResult } from '../types'

export interface HealthResponse {
  status: string
  ocr_pipeline_ready: boolean
  ocr_model_loading?: boolean
  ocr_model_load_error?: string | null
  model: string
}

interface RecognitionBlocks {
  blocks: Array<{
    text: string
    layout_type?: string
    bbox: number[] | number[][]
    block_order?: number | null
  }>
  total_blocks: number
  extracted_text: string
}

interface ApiPageResult {
  page_index: number
  image_shape: { height: number; width: number; channels: number }
  preview_image_base64?: string
  thumbnail_base64?: string
  preview_image_mime?: string
  recognition_result: RecognitionBlocks
}

export interface RecognizeImageResponse {
  success: boolean
  data: {
    task_id: string
    image_path: string
    image_shape: { height: number; width: number; channels: number }
    recognition_result: RecognitionBlocks
    total_processing_time: number
    is_pdf?: boolean
    page_count?: number
    pages?: ApiPageResult[]
    preview_image_base64?: string
    preview_image_mime?: string
  }
}

export interface ModelsStatusResponse {
  status: string
  pipeline_ready: boolean
  models: Record<string, { exists: boolean; description: string }>
}

/** 将 PaddleOCR-VL bbox 转为四边形顶点 */
export function bboxToBox(bbox: number[] | number[][] | undefined): [number, number][] {
  if (!bbox || bbox.length === 0) {
    return [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]
  }

  if (Array.isArray(bbox[0])) {
    return (bbox as number[][]).slice(0, 4).map((p) => [p[0], p[1]]) as [number, number][]
  }

  const flat = bbox as number[]
  if (flat.length >= 8) {
    return [
      [flat[0], flat[1]],
      [flat[2], flat[3]],
      [flat[4], flat[5]],
      [flat[6], flat[7]],
    ]
  }
  if (flat.length >= 4) {
    const [x1, y1, x2, y2] = flat
    return [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2],
    ]
  }

  return [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ]
}

export function blocksToOcrResults(blocks: RecognitionBlocks['blocks']): OcrBox[] {
  return blocks
    .filter((b) => b.text && !b.text.startsWith('解析失败'))
    .map((b) => ({
      box: bboxToBox(b.bbox),
      text: b.text,
      layout_type: b.layout_type,
    }))
}

function toDataUrl(base64: string | undefined, mime = 'image/jpeg'): string | undefined {
  if (!base64) return undefined
  return `data:${mime};base64,${base64}`
}

function parsePageResult(page: ApiPageResult): OcrPageResult {
  const mime = page.preview_image_mime ?? 'image/jpeg'
  return {
    pageIndex: page.page_index,
    results: blocksToOcrResults(page.recognition_result.blocks),
    width: page.image_shape?.width,
    height: page.image_shape?.height,
    previewImageUrl: toDataUrl(page.preview_image_base64, mime),
    thumbnailUrl: toDataUrl(page.thumbnail_base64 ?? page.preview_image_base64, mime),
  }
}

export async function checkOcrHealth(): Promise<{
  ocr_engine: string
  ready: boolean
  loading: boolean
  loadError: string | null
}> {
  const res = await fetch('/health')
  if (!res.ok) throw new Error('OCR 服务不可用')
  const data: HealthResponse = await res.json()
  return {
    ocr_engine: data.model ?? 'PaddleOCR-VL',
    ready: data.ocr_pipeline_ready,
    loading: Boolean(data.ocr_model_loading),
    loadError: data.ocr_model_load_error ?? null,
  }
}

export async function getModelsStatus(): Promise<ModelsStatusResponse> {
  const res = await fetch('/api/models/status')
  if (!res.ok) throw new Error('无法获取模型状态')
  return res.json()
}

export async function runOcr(file: File): Promise<OcrResult> {
  const form = new FormData()
  form.append('file', file)

  const res = await fetch('/api/recognize/image', {
    method: 'POST',
    body: form,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail ?? `OCR 请求失败 (${res.status})`)
  }

  const json: RecognizeImageResponse = await res.json()
  if (!json.success || !json.data) {
    throw new Error('OCR 返回结果异常')
  }

  const { data } = json
  const isPdf =
    data.is_pdf ??
    (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))

  if (data.pages?.length) {
    const pages = data.pages.map(parsePageResult)
    return {
      image: file.name,
      results: [],
      engine: 'PaddleOCR-VL',
      extractedText: data.recognition_result.extracted_text,
      taskId: data.task_id,
      isPdf: true,
      pageCount: data.page_count ?? pages.length,
      pages,
    }
  }

  const results = blocksToOcrResults(data.recognition_result.blocks)
  const previewImageUrl = toDataUrl(
    data.preview_image_base64,
    data.preview_image_mime ?? 'image/jpeg',
  )

  return {
    image: file.name,
    results,
    engine: 'PaddleOCR-VL',
    width: data.image_shape?.width,
    height: data.image_shape?.height,
    extractedText: data.recognition_result.extracted_text,
    taskId: data.task_id,
    isPdf,
    previewImageUrl,
  }
}
