import { useCallback, useEffect, useRef, useState } from 'react'
import type { OcrBox } from '../types'

interface ImageViewerProps {
  imageUrl: string
  boxes: OcrBox[]
  selectedIndex: number | null
  adoptedIndices: Set<number>
  onSelect: (index: number) => void
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 4
const ZOOM_STEP = 0.25

export function ImageViewer({
  imageUrl,
  boxes,
  selectedIndex,
  adoptedIndices,
  onSelect,
}: ImageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [fitScale, setFitScale] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 })

  const displayScale = fitScale * zoom

  const updateFitScale = useCallback(() => {
    const container = containerRef.current
    const img = imageRef.current
    if (!container || !img?.naturalWidth) return

    const maxW = container.clientWidth - 32
    const maxH = container.clientHeight - 32
    const s = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight)
    setFitScale(s)
  }, [])

  const clampZoom = (value: number) =>
    Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))

  const handleZoomIn = () => setZoom((z) => clampZoom(z + ZOOM_STEP))
  const handleZoomOut = () => setZoom((z) => clampZoom(z - ZOOM_STEP))
  const handleZoomReset = () => setZoom(1)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img || !img.complete) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    boxes.forEach((item, index) => {
      const isSelected = selectedIndex === index
      const isAdopted = adoptedIndices.has(index)

      ctx.beginPath()
      item.box.forEach(([x, y], i) => {
        const px = x * displayScale
        const py = y * displayScale
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.closePath()

      if (isSelected) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.12)'
        ctx.fill()
        ctx.strokeStyle = '#2563eb'
        ctx.lineWidth = 2.5
      } else if (isAdopted) {
        ctx.fillStyle = 'rgba(34, 197, 94, 0.1)'
        ctx.fill()
        ctx.strokeStyle = '#16a34a'
        ctx.lineWidth = 2
      } else {
        ctx.strokeStyle = '#f97316'
        ctx.lineWidth = 1.5
      }
      ctx.stroke()
    })
  }, [boxes, selectedIndex, adoptedIndices, displayScale])

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
      setZoom(1)
      requestAnimationFrame(updateFitScale)
    }
    img.src = imageUrl
  }, [imageUrl, updateFitScale])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(updateFitScale)
    observer.observe(container)
    return () => observer.disconnect()
  }, [updateFitScale])

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

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = imageSize.width * displayScale
    canvas.height = imageSize.height * displayScale
    draw()
  }, [imageSize, displayScale, draw])

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) / displayScale
    const y = (e.clientY - rect.top) / displayScale

    for (let i = boxes.length - 1; i >= 0; i--) {
      const box = boxes[i].box
      const xs = box.map((p) => p[0])
      const ys = box.map((p) => p[1])
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        onSelect(i)
        return
      }
    }
  }

  const stageWidth = imageSize.width * displayScale
  const stageHeight = imageSize.height * displayScale

  return (
    <div className="image-viewer" ref={containerRef}>
      <div className="viewer-toolbar">
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
            适应窗口
          </button>
        </div>
        <span className="viewer-zoom-hint">Ctrl + 滚轮缩放</span>
      </div>

      <div
        className="image-stage"
        style={{ width: stageWidth, height: stageHeight }}
      >
        <img
          src={imageUrl}
          alt="OCR 原图"
          className="source-image"
          style={{ width: stageWidth, height: stageHeight }}
          draggable={false}
        />
        <canvas
          ref={canvasRef}
          className="overlay-canvas"
          onClick={handleCanvasClick}
        />
      </div>

      <div className="viewer-legend">
        <span className="legend-item legend-detect">检测框</span>
        <span className="legend-item legend-selected">已选中</span>
        <span className="legend-item legend-adopted">已采纳</span>
      </div>
    </div>
  )
}
