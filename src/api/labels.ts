import type { LabelBatch, StoredLabelBatch } from '../types/labeling'
import { authFetch } from './auth'
import { batchFromStored, serializeBatchForStorage } from '../utils/labelingStorage'

interface LoadBatchResponse {
  batch: StoredLabelBatch | null
  updated_at: string | null
}

export async function loadRemoteLabelBatch(): Promise<LabelBatch | null> {
  const res = await authFetch('/api/label/batch')
  if (!res.ok) throw new Error('加载标注数据失败')
  const data: LoadBatchResponse = await res.json()
  if (!data.batch) return null
  return batchFromStored(data.batch)
}

export async function saveRemoteLabelBatch(batch: LabelBatch): Promise<string> {
  const payload = serializeBatchForStorage(batch)
  const res = await authFetch('/api/label/batch', {
    method: 'PUT',
    body: JSON.stringify({ batch: payload }),
  })
  if (!res.ok) throw new Error('保存标注数据失败')
  const data: { updated_at: string } = await res.json()
  return data.updated_at
}

export async function clearRemoteLabelBatch(): Promise<void> {
  const res = await authFetch('/api/label/batch', { method: 'DELETE' })
  if (!res.ok) throw new Error('清空标注数据失败')
}
