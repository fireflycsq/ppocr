/** 送入大模型前的单页 JPEG（与 buildPageRequestBody 使用的 base64 一致） */
export interface ModelPageImagePreview {
  pageIndex: number
  totalPages: number
  base64: string
  width: number
  height: number
}

export function modelPageImageDataUrl(base64: string): string {
  return `data:image/jpeg;base64,${base64}`
}

export function downloadModelPageImage(
  image: ModelPageImagePreview,
  pdfFileName: string,
): void {
  const pageNum = image.pageIndex + 1
  const base = pdfFileName.replace(/\.pdf$/i, '') || 'document'
  const link = document.createElement('a')
  link.href = modelPageImageDataUrl(image.base64)
  link.download = `${base}-model-input-p${pageNum}-${image.width}x${image.height}.jpg`
  link.click()
}
