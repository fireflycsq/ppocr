import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url,
).toString()

export interface PdfPageImage {
  /** 从 0 开始的页码 */
  pageIndex: number
  /** 不带 data: 前缀的 base64，直接传给 Ollama images */
  base64: string
  width: number
  height: number
}

/** 渲染分辨率上限（长边像素）。略降可明显加快 VL 推理，减少 502 */
const MAX_DIMENSION = 1600

export interface RenderPdfOptions {
  maxDimension?: number
  jpegQuality?: number
  pageLimit?: number
}

export interface PdfPageRenderContext {
  pageIndex: number
  totalPages: number
  render: (options?: RenderPdfOptions) => Promise<PdfPageImage>
}

/** 一次打开 PDF，允许调用方逐页按需渲染低清/高清图。 */
export async function processPdfPages<T>(
  file: File,
  processor: (page: PdfPageRenderContext) => Promise<T>,
): Promise<T[]> {
  const data = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const results: T[] = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const render = async (
      options: RenderPdfOptions = {},
    ): Promise<PdfPageImage> => {
      const maxDimension = options.maxDimension ?? MAX_DIMENSION
      const jpegQuality = options.jpegQuality ?? 0.75
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = Math.min(
        2.5,
        maxDimension / Math.max(baseViewport.width, baseViewport.height),
      )
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建画布，浏览器不支持 canvas')
      await page.render({ canvasContext: context, viewport }).promise
      const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality)
      return {
        pageIndex: pageNum - 1,
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        width: canvas.width,
        height: canvas.height,
      }
    }
    results.push(
      await processor({
        pageIndex: pageNum - 1,
        totalPages: pdf.numPages,
        render,
      }),
    )
  }
  return results
}

/** 将 PDF 每一页渲染为 JPEG base64 图片，供多模态模型逐页识别 */
export async function renderPdfPagesToImages(
  file: File,
  onProgress?: (done: number, total: number) => void,
  options: RenderPdfOptions = {},
): Promise<PdfPageImage[]> {
  const data = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const images: PdfPageImage[] = []
  const total = Math.min(pdf.numPages, options.pageLimit ?? pdf.numPages)
  const maxDimension = options.maxDimension ?? MAX_DIMENSION
  const jpegQuality = options.jpegQuality ?? 0.75

  for (let pageNum = 1; pageNum <= total; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(
      2.5,
      maxDimension / Math.max(baseViewport.width, baseViewport.height),
    )
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布，浏览器不支持 canvas')

    await page.render({ canvasContext: context, viewport }).promise

    // 0.75 在单证文字场景下通常足够，体积更小、推理更快
    const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality)
    images.push({
      pageIndex: pageNum - 1,
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      width: canvas.width,
      height: canvas.height,
    })
    onProgress?.(pageNum, total)
  }

  return images
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取图片文件'))
    }
    img.src = url
  })
}

/** 将单张图片缩放后转为 JPEG base64，供多模态模型识别 */
export async function renderImageFileToBase64(
  file: File,
  options: Pick<RenderPdfOptions, 'maxDimension' | 'jpegQuality'> = {},
): Promise<string> {
  const maxDimension = options.maxDimension ?? MAX_DIMENSION
  const jpegQuality = options.jpegQuality ?? 0.75
  const img = await loadImageFromFile(file)
  const scale = Math.min(
    1,
    maxDimension / Math.max(img.naturalWidth, img.naturalHeight),
  )
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建画布，浏览器不支持 canvas')
  context.drawImage(img, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality)
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
