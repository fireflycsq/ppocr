import { unzip } from 'fflate'

export interface ZipJsonEntry {
  /** 压缩包内路径 */
  path: string
  /** 文件文本内容 */
  text: string
}

function shouldSkipEntry(path: string): boolean {
  if (!/\.json$/i.test(path)) return true
  if (path.includes('__MACOSX/')) return true
  const base = path.split('/').pop() ?? path
  return base.startsWith('.')
}

/** 解压 zip，返回其中所有 JSON 文件的文本内容（跳过 macOS 元数据与隐藏文件） */
export async function readZipJsonEntries(file: File): Promise<ZipJsonEntry[]> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(buffer, { filter: (info) => !shouldSkipEntry(info.name) }, (err, data) => {
      if (err) reject(new Error(`解压失败：${err.message}`))
      else resolve(data)
    })
  })

  const decoder = new TextDecoder('utf-8')
  return Object.entries(files)
    .filter(([, data]) => data.length > 0)
    .map(([path, data]) => ({ path, text: decoder.decode(data) }))
}
