import { useCallback, useEffect, useState } from 'react'

interface PersistedPanelWidthOptions {
  storageKey?: string
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
}

export function usePersistedPanelWidth(
  options: PersistedPanelWidthOptions = {},
) {
  const storageKey = options.storageKey ?? 'ppocr-label-right-panel-width'
  const defaultWidth = options.defaultWidth ?? 440
  const minWidth = options.minWidth ?? 320
  const maxWidth = options.maxWidth ?? 960
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(storageKey)
    const parsed = stored ? Number(stored) : defaultWidth
    if (!Number.isFinite(parsed)) return defaultWidth
    return Math.min(maxWidth, Math.max(minWidth, parsed))
  })

  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = width

      const handleMove = (moveEvent: MouseEvent) => {
        const nextWidth = startWidth + (startX - moveEvent.clientX)
        setWidth(Math.min(maxWidth, Math.max(minWidth, nextWidth)))
      }

      const handleUp = () => {
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    },
    [maxWidth, minWidth, width],
  )

  return { width, setWidth, startResize, minWidth, maxWidth }
}
