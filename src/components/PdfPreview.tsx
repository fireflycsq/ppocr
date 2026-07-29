import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url,
).toString()

interface PdfPreviewProps {
  url: string
  className?: string
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 4
const ZOOM_STEP = 0.25

function waitForLayout(el: HTMLElement, maxFrames = 30): Promise<void> {
  return new Promise((resolve) => {
    let frames = 0
    const tick = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        resolve()
        return
      }
      frames += 1
      if (frames >= maxFrames) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

function clampZoom(value: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

export function PdfPreview({ url, className }: PdfPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [containerWidth, setContainerWidth] = useState(0)

  const handleZoomIn = () => setZoom((z) => clampZoom(z + ZOOM_STEP))
  const handleZoomOut = () => setZoom((z) => clampZoom(z - ZOOM_STEP))
  const handleZoomReset = () => setZoom(1)

  useEffect(() => {
    setZoom(1)
  }, [url])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const updateWidth = () => setContainerWidth(root.clientWidth)
    updateWidth()

    const observer = new ResizeObserver(updateWidth)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const container = containerRef.current
    if (!root || !container) return

    let cancelled = false
    const tasks: Array<{ cancel?: () => void }> = []

    setLoading(true)
    setError(null)
    container.replaceChildren()

    const renderPdf = async () => {
      await waitForLayout(root)
      if (cancelled) return

      const width = container.clientWidth || containerWidth || root.clientWidth || 600

      try {
        const pdf = await pdfjsLib.getDocument(url).promise
        if (cancelled) return

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (cancelled) return

          const page = await pdf.getPage(pageNum)
          const baseViewport = page.getViewport({ scale: 1 })
          const fitScale = Math.min(2, Math.max(0.1, (width - 16) / baseViewport.width))
          const viewport = page.getViewport({ scale: fitScale * zoom })

          const pageWrap = document.createElement('div')
          pageWrap.className = 'pdf-preview-page-wrap'
          pageWrap.style.width = `${viewport.width}px`
          pageWrap.style.height = `${viewport.height}px`

          const canvas = document.createElement('canvas')
          canvas.className = 'pdf-preview-page-canvas'
          const context = canvas.getContext('2d')
          if (!context) continue

          canvas.width = viewport.width
          canvas.height = viewport.height

          const textLayer = document.createElement('div')
          textLayer.className = 'textLayer'

          pageWrap.appendChild(canvas)
          pageWrap.appendChild(textLayer)
          container.appendChild(pageWrap)

          const renderTask = page.render({ canvasContext: context, viewport })
          tasks.push(renderTask)
          await renderTask.promise
          if (cancelled) return

          const textContent = await page.getTextContent()
          if (cancelled) return

          const textTask = pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport,
          })
          tasks.push(textTask)
          await textTask.promise
        }
      } catch {
        if (!cancelled) setError('PDF 加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    renderPdf()

    return () => {
      cancelled = true
      tasks.forEach((task) => task.cancel?.())
    }
  }, [url, zoom, containerWidth])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) =>
        clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)),
      )
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [])

  return (
    <div ref={rootRef} className={`pdf-preview ${className ?? ''}`}>
      <div className="pdf-preview-toolbar viewer-toolbar">
        <div className="viewer-zoom">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={handleZoomOut}
            disabled={zoom <= ZOOM_MIN}
            title="缩小"
            aria-label="缩小"
          >
            −
          </button>
          <span className="viewer-zoom-label">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={handleZoomIn}
            disabled={zoom >= ZOOM_MAX}
            title="放大"
            aria-label="放大"
          >
            +
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleZoomReset}
            disabled={zoom === 1}
            title="重置缩放"
          >
            适应宽度
          </button>
        </div>
        <span className="viewer-zoom-hint">Ctrl + 滚轮缩放 · 可选中文字</span>
      </div>
      <div ref={containerRef} className="pdf-preview-pages" />
      {loading && <div className="pdf-preview-status">加载中…</div>}
      {error && <div className="pdf-preview-status pdf-preview-error">{error}</div>}
    </div>
  )
}
