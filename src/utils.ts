import type { OcrResult } from './types'

/** 示例 OCR 预识别数据（身份证样式布局，坐标为示意值） */
export const demoOcrResult: OcrResult = {
  image: '/demo-id-card.svg',
  results: [
    {
      box: [
        [120, 45],
        [280, 45],
        [280, 78],
        [120, 78],
      ],
      text: '姓名',
      confidence: 0.992,
    },
    {
      box: [
        [290, 45],
        [520, 45],
        [520, 78],
        [290, 78],
      ],
      text: '张三',
      confidence: 0.987,
    },
    {
      box: [
        [120, 95],
        [280, 95],
        [280, 128],
        [120, 128],
      ],
      text: '性别',
      confidence: 0.991,
    },
    {
      box: [
        [290, 95],
        [360, 95],
        [360, 128],
        [290, 128],
      ],
      text: '男',
      confidence: 0.995,
    },
    {
      box: [
        [400, 95],
        [480, 95],
        [480, 128],
        [400, 128],
      ],
      text: '民族',
      confidence: 0.989,
    },
    {
      box: [
        [490, 95],
        [560, 95],
        [560, 128],
        [490, 128],
      ],
      text: '汉',
      confidence: 0.993,
    },
    {
      box: [
        [120, 145],
        [280, 145],
        [280, 178],
        [120, 178],
      ],
      text: '出生',
      confidence: 0.988,
    },
    {
      box: [
        [290, 145],
        [620, 145],
        [620, 178],
        [290, 178],
      ],
      text: '1990年01月15日',
      confidence: 0.976,
    },
    {
      box: [
        [120, 195],
        [280, 195],
        [280, 228],
        [120, 228],
      ],
      text: '住址',
      confidence: 0.99,
    },
    {
      box: [
        [290, 195],
        [680, 195],
        [680, 260],
        [290, 260],
      ],
      text: '北京市朝阳区某某街道123号',
      confidence: 0.962,
    },
    {
      box: [
        [120, 280],
        [420, 280],
        [420, 313],
        [120, 313],
      ],
      text: '公民身份号码',
      confidence: 0.994,
    },
    {
      box: [
        [120, 325],
        [680, 325],
        [680, 365],
        [120, 365],
      ],
      text: '110105199001151234',
      confidence: 0.981,
    },
  ],
}

export const defaultFields = [
  { id: '1', key: 'name', label: '姓名' },
  { id: '2', key: 'gender', label: '性别' },
  { id: '3', key: 'ethnicity', label: '民族' },
  { id: '4', key: 'birthday', label: '出生日期' },
  { id: '5', key: 'address', label: '住址' },
  { id: '6', key: 'id_number', label: '身份证号' },
]

export function boxToRect(box: [number, number][]) {
  const xs = box.map((p) => p[0])
  const ys = box.map((p) => p[1])
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function parseOcrJson(text: string): OcrResult {
  const parsed = JSON.parse(text)
  if (Array.isArray(parsed)) {
    return { results: parsed }
  }
  if (parsed.results && Array.isArray(parsed.results)) {
    return parsed as OcrResult
  }
  if (parsed.data && Array.isArray(parsed.data)) {
    return { results: parsed.data, image: parsed.image }
  }
  throw new Error('无法识别的 OCR JSON 格式，需要包含 results 数组')
}
