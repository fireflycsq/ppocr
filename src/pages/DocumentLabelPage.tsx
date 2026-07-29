import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearRemoteLabelBatch, loadRemoteLabelBatch, saveRemoteLabelBatch } from '../api/labels'
import { PdfPreview } from '../components/PdfPreview'
import { DocumentAnnotationPanel } from '../components/labeling/DocumentAnnotationPanel'
import { FieldListEditor } from '../components/labeling/FieldListEditor'
import { LabelDocumentList } from '../components/labeling/LabelDocumentList'
import { useAuth } from '../contexts/AuthContext'
import { usePersistedPanelWidth } from '../hooks/usePersistedPanelWidth'
import { LoginPage } from './LoginPage'
import type {
  DocumentCategory,
  DocumentFilter,
  InvoiceEntry,
  LabelBatch,
  SublistRow,
  TargetStructureType,
} from '../types/labeling'
import type { FieldDefinition } from '../types'
import {
  buildBatchSummary,
  clearSavedLabelBatch,
  createEmptyBatch,
  createEmptyInvoiceEntry,
  createEmptySublistRow,
  createPredefinedField,
  exportLabelBatch,
  exportLabelDocument,
  loadLabelBatch,
  mergeUploadedFiles,
  revokeDocumentUrls,
  saveLabelBatch,
} from '../utils/labelingStorage'
import {
  applyTemplateDefaultsToDocument,
  applyTemplateDefaultsToInvoiceEntry,
  applyTemplateToBatch,
  buildDefaultSublistRows,
  getLabelTemplate,
  LABEL_TEMPLATES,
} from '../utils/labelTemplates'

type FieldScope = 'header' | 'sublist'

export default function DocumentLabelPage() {
  const { user, loading: authLoading } = useAuth()
  const [batch, setBatch] = useState<LabelBatch>(() => createEmptyBatch())
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchReady, setBatchReady] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<DocumentFilter>('all')
  const [toast, setToast] = useState<string | null>(null)
  const [showFieldsEditor, setShowFieldsEditor] = useState(true)
  const { width: rightPanelWidth, setWidth: setRightPanelWidth, startResize } =
    usePersistedPanelWidth()

  const selectedDoc = useMemo(
    () => batch.documents.find((doc) => doc.id === selectedId) ?? null,
    [batch.documents, selectedId],
  )

  const summary = useMemo(
    () => buildBatchSummary(batch.documents),
    [batch.documents],
  )

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 2800)
  }, [])

  const documentsRef = useRef(batch.documents)
  documentsRef.current = batch.documents

  useEffect(() => {
    return () => revokeDocumentUrls(documentsRef.current)
  }, [])

  useEffect(() => {
    if (!user) {
      setBatchReady(false)
      return
    }

    let cancelled = false
    setBatchLoading(true)

    loadRemoteLabelBatch()
      .then((remoteBatch) => {
        if (cancelled) return

        if (remoteBatch) {
          setBatch(remoteBatch)
          setSelectedId(remoteBatch.documents[0]?.id ?? null)
          setBatchReady(true)
          return
        }

        const localBatch = loadLabelBatch()
        if (localBatch && localBatch.documents.length > 0) {
          setBatch(localBatch)
          setSelectedId(localBatch.documents[0]?.id ?? null)
          saveRemoteLabelBatch(localBatch)
            .then(() => showToast('已将本机标注同步到服务器'))
            .catch(() => showToast('本机标注加载成功，但同步到服务器失败'))
        } else {
          setBatch(createEmptyBatch())
          setSelectedId(null)
        }
        setBatchReady(true)
      })
      .catch(() => {
        if (cancelled) return
        const localBatch = loadLabelBatch()
        setBatch(localBatch ?? createEmptyBatch())
        setSelectedId(localBatch?.documents[0]?.id ?? null)
        setBatchReady(true)
        showToast('无法连接服务器，已使用本机缓存')
      })
      .finally(() => {
        if (!cancelled) setBatchLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [user, showToast])

  const updateBatch = (updater: (prev: LabelBatch) => LabelBatch) => {
    setBatch((prev) => updater(prev))
  }

  const handleUpload = (files: File[]) => {
    updateBatch((prev) => mergeUploadedFiles(prev, files))
    showToast(`已添加 ${files.length} 个 PDF`)
  }

  const handleRemoveDocument = (id: string) => {
    updateBatch((prev) => {
      const target = prev.documents.find((doc) => doc.id === id)
      if (target?.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl)
      }
      const documents = prev.documents.filter((doc) => doc.id !== id)
      if (selectedId === id) setSelectedId(documents[0]?.id ?? null)
      return { ...prev, documents }
    })
  }

  const patchSelectedDoc = (
    patch: Partial<(typeof batch.documents)[number]>,
  ) => {
    if (!selectedId) return
    updateBatch((prev) => ({
      ...prev,
      documents: prev.documents.map((doc) =>
        doc.id === selectedId ? { ...doc, ...patch } : doc,
      ),
    }))
  }

  const handleCategoryChange = (category: DocumentCategory) => {
    if (category === 'non_target') {
      patchSelectedDoc({ category })
      return
    }
    patchSelectedDoc({ category })
  }

  const handleStructureChange = (structureType: TargetStructureType) => {
    if (!selectedDoc) return
    const patch: Partial<(typeof batch.documents)[number]> = { structureType }

    if (structureType === 'multi_invoice' && selectedDoc.invoiceEntries.length === 0) {
      patch.invoiceEntries = [createEmptyInvoiceEntry(false)]
    }
    if (structureType === 'multi_invoice_with_sublist') {
      const entries =
        selectedDoc.invoiceEntries.length > 0
          ? selectedDoc.invoiceEntries
          : [createEmptyInvoiceEntry(true, batch.layoutTemplateId)]
      patch.invoiceEntries = entries.map((entry) => ({
        ...entry,
        fieldValues:
          Object.keys(entry.fieldValues).length > 0
            ? entry.fieldValues
            : applyTemplateDefaultsToInvoiceEntry(
                getLabelTemplate(batch.layoutTemplateId),
              ).fieldValues,
        sublistRows:
          entry.sublistRows?.length &&
          entry.sublistRows.some((row) =>
            Object.values(row.cells).some((value) => value.trim()),
          )
            ? entry.sublistRows
            : buildDefaultSublistRows(getLabelTemplate(batch.layoutTemplateId)),
      }))
    }
    if (structureType === 'invoice_with_sublist') {
      if (Object.keys(selectedDoc.invoiceHeader).length === 0 && selectedDoc.fieldValues) {
        patch.invoiceHeader = { ...selectedDoc.fieldValues }
      }
      if (selectedDoc.sublistRows.length === 0) {
        patch.sublistRows = [createEmptySublistRow()]
      }
    }

    patchSelectedDoc(patch)
  }

  const handleSingleFieldChange = (fieldId: string, value: string) => {
    if (!selectedDoc) return
    patchSelectedDoc({
      fieldValues: { ...selectedDoc.fieldValues, [fieldId]: value },
    })
  }

  const handleInvoiceEntriesChange = (entries: InvoiceEntry[]) => {
    patchSelectedDoc({ invoiceEntries: entries })
  }

  const handleInvoiceHeaderChange = (fieldId: string, value: string) => {
    if (!selectedDoc) return
    patchSelectedDoc({
      invoiceHeader: { ...selectedDoc.invoiceHeader, [fieldId]: value },
    })
  }

  const handleSublistRowsChange = (rows: SublistRow[]) => {
    patchSelectedDoc({ sublistRows: rows })
  }

  const handleNoteChange = (note: string) => {
    patchSelectedDoc({ note })
  }

  const handleSaveDocument = () => {
    if (!selectedDoc?.category) return
    patchSelectedDoc({ updatedAt: new Date().toISOString() })
    showToast(`已保存：${selectedDoc.fileName}`)
  }

  const handleSaveBatch = async () => {
    try {
      const updated = { ...batch, updatedAt: new Date().toISOString() }
      const savedAt = await saveRemoteLabelBatch(updated)
      const saved = { ...updated, updatedAt: savedAt }
      setBatch(saved)
      saveLabelBatch(saved)
      showToast('批次标注已保存到服务器')
    } catch {
      const saved = saveLabelBatch(batch)
      setBatch(saved)
      showToast('服务器保存失败，已暂存到浏览器本地')
    }
  }

  const handleExportDocument = () => {
    if (!selectedDoc || !selectedDoc.category) return
    exportLabelDocument(selectedDoc, batch.headerFields, batch.sublistColumns)
    showToast(`已导出：${selectedDoc.fileName.replace(/\.pdf$/i, '.json')}`)
  }

  const handleExport = () => {
    if (batch.documents.length === 0) {
      showToast('请先上传 PDF 后再导出')
      return
    }
    exportLabelBatch(batch)
    showToast('批量导出 JSON 已开始下载')
  }

  const handleResetBatch = async () => {
    if (!window.confirm('确定清空当前批次？服务器与本地的标注都会被清除。')) return
    revokeDocumentUrls(batch.documents)
    try {
      await clearRemoteLabelBatch()
    } catch {
      showToast('服务器清空失败，仅清除了本机缓存')
    }
    clearSavedLabelBatch()
    const empty = createEmptyBatch()
    setBatch(empty)
    setSelectedId(null)
    showToast('已清空当前批次')
  }

  const cleanFieldFromDocuments = (
    documents: LabelBatch['documents'],
    fieldId: string,
    scope: FieldScope,
  ) => {
    return documents.map((doc) => {
      if (scope === 'header') {
        const nextFieldValues = { ...doc.fieldValues }
        delete nextFieldValues[fieldId]
        const invoiceEntries = doc.invoiceEntries.map((entry) => {
          const fv = { ...entry.fieldValues }
          delete fv[fieldId]
          return { ...entry, fieldValues: fv }
        })
        const invoiceHeader = { ...doc.invoiceHeader }
        delete invoiceHeader[fieldId]
        return {
          ...doc,
          fieldValues: nextFieldValues,
          invoiceEntries,
          invoiceHeader,
        }
      }
      const sublistRows = doc.sublistRows.map((row) => {
        const cells = { ...row.cells }
        delete cells[fieldId]
        return { ...row, cells }
      })
      const invoiceEntries = doc.invoiceEntries.map((entry) => {
        const rows = (entry.sublistRows ?? []).map((row) => {
          const cells = { ...row.cells }
          delete cells[fieldId]
          return { ...row, cells }
        })
        return { ...entry, sublistRows: rows }
      })
      return { ...doc, sublistRows, invoiceEntries }
    })
  }

  const handleAddField = (scope: FieldScope) => {
    const field = createPredefinedField()
    updateBatch((prev) => ({
      ...prev,
      headerFields:
        scope === 'header'
          ? [...prev.headerFields, field]
          : prev.headerFields,
      sublistColumns:
        scope === 'sublist'
          ? [...prev.sublistColumns, field]
          : prev.sublistColumns,
    }))
  }

  const handleRemoveField = (scope: FieldScope, id: string) => {
    updateBatch((prev) => ({
      ...prev,
      headerFields:
        scope === 'header'
          ? prev.headerFields.filter((f) => f.id !== id)
          : prev.headerFields,
      sublistColumns:
        scope === 'sublist'
          ? prev.sublistColumns.filter((f) => f.id !== id)
          : prev.sublistColumns,
      documents: cleanFieldFromDocuments(prev.documents, id, scope),
    }))
  }

  const handleUpdateField = (
    scope: FieldScope,
    id: string,
    patch: Partial<FieldDefinition>,
  ) => {
    const listKey = scope === 'header' ? 'headerFields' : 'sublistColumns'
    updateBatch((prev) => ({
      ...prev,
      [listKey]: prev[listKey].map((f) => (f.id === id ? { ...f, ...patch } : f)),
    }))
  }

  const handleTemplateChange = (templateId: string) => {
    if (templateId === batch.layoutTemplateId) return
    const template = getLabelTemplate(templateId)
    const hasData = batch.documents.length > 0
    if (
      hasData &&
      !window.confirm(
        `切换为「${template.name}」将更新字段配置，已有标注会按字段键名尽量保留。确定切换？`,
      )
    ) {
      return
    }
    updateBatch((prev) => applyTemplateToBatch(prev, templateId))
    showToast(`已切换为：${template.name}`)
  }

  const handleApplyTemplateDefaults = () => {
    if (!selectedDoc) return
    const template = getLabelTemplate(batch.layoutTemplateId)
    if (
      !window.confirm(
        selectedDoc.structureType === 'multi_invoice_with_sublist'
          ? '将用当前版式的预填值覆盖所有发票的头字段与子清单明细，已有内容会被替换。确定继续？'
          : '将用当前版式的预填值覆盖当前发票头与子清单明细，已有内容会被替换。确定继续？',
      )
    ) {
      return
    }
    const patch = applyTemplateDefaultsToDocument(selectedDoc, template)
    patchSelectedDoc(patch)
    showToast('已填入版式预填值')
  }

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const step = event.shiftKey ? 40 : 16
      const delta = event.key === 'ArrowLeft' ? step : -step
      setRightPanelWidth((current) => Math.min(960, Math.max(320, current + delta)))
    },
    [setRightPanelWidth],
  )

  if (authLoading) {
    return (
      <div className="label-page label-page-loading">
        <p>正在检查登录状态…</p>
      </div>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  if (!batchReady || batchLoading) {
    return (
      <div className="label-page label-page-loading">
        <p>正在加载您的标注数据…</p>
      </div>
    )
  }

  return (
    <div className="label-page">
      <header className="page-header">
        <div className="brand">
          <h1>单证标注</h1>
          <p>
            批量上传 PDF → 分类 → 选择结构（单发票/多发票/发票+子清单/多发票+子清单）→ 保存 → 导出
          </p>
        </div>
        <div className="label-toolbar">
          <button type="button" className="btn btn-outline" onClick={() => void handleSaveBatch()}>
            保存批次
          </button>
          <button type="button" className="btn btn-primary" onClick={handleExport}>
            批量导出 JSON
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void handleResetBatch()}>
            清空批次
          </button>
        </div>
      </header>

      <div className="label-summary-bar">
        <span>共 {summary.total} 个 PDF</span>
        <span>目标 {summary.target}</span>
        <span>非目标 {summary.nonTarget}</span>
        <span>未分类 {summary.unclassified}</span>
        <span>已标注 {summary.annotated}</span>
        <span className="label-batch-name">批次：{batch.name}</span>
      </div>

      {toast && <div className="toast-banner">{toast}</div>}

      <main
        className="label-layout"
        style={
          {
            '--label-right-panel-width': `${rightPanelWidth}px`,
          } as React.CSSProperties
        }
      >
        <LabelDocumentList
          documents={batch.documents}
          selectedId={selectedId}
          filter={filter}
          onFilterChange={setFilter}
          onSelect={setSelectedId}
          onUpload={handleUpload}
          onRemove={handleRemoveDocument}
        />

        <section className="label-preview-panel">
          <div className="panel-title">
            <h2>PDF 预览</h2>
            {selectedDoc && (
              <span>{(selectedDoc.fileSize / 1024).toFixed(1)} KB</span>
            )}
          </div>
          <div className="label-preview-scroll">
            {selectedDoc?.previewUrl ? (
              <PdfPreview
                url={selectedDoc.previewUrl}
                className="label-pdf-preview"
              />
            ) : selectedDoc ? (
              <div className="empty-state label-preview-empty">
                <p>该单证暂无预览</p>
                <p className="hint-secondary">
                  标注数据已保留，请重新上传同名 PDF 恢复预览
                </p>
              </div>
            ) : (
              <div className="empty-state label-preview-empty">
                <p>选择左侧 PDF 进行预览与标注</p>
              </div>
            )}
          </div>
        </section>

        <div
          className="label-panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整录入面板宽度"
          tabIndex={0}
          onMouseDown={startResize}
          onKeyDown={handleResizeKeyDown}
          title="拖动调整录入面板宽度"
        />

        <section className="label-right-panel">
          <DocumentAnnotationPanel
            document={selectedDoc}
            headerFields={batch.headerFields}
            sublistColumns={batch.sublistColumns}
            layoutTemplateId={batch.layoutTemplateId}
            onCategoryChange={handleCategoryChange}
            onStructureChange={handleStructureChange}
            onSingleFieldChange={handleSingleFieldChange}
            onInvoiceEntriesChange={handleInvoiceEntriesChange}
            onInvoiceHeaderChange={handleInvoiceHeaderChange}
            onSublistRowsChange={handleSublistRowsChange}
            onApplyTemplateDefaults={handleApplyTemplateDefaults}
            onNoteChange={handleNoteChange}
            onSaveDocument={handleSaveDocument}
            onExportDocument={handleExportDocument}
          />

          <button
            type="button"
            className="label-fields-toggle"
            onClick={() => setShowFieldsEditor((v) => !v)}
          >
            {showFieldsEditor ? '收起' : '展开'}预定义字段配置
          </button>

          {showFieldsEditor && (
            <div className="label-field-config">
              <section className="label-template-section">
                <h3>标注版式</h3>
                <p className="label-hint">
                  选择版式将更新发票头字段与子清单列；新上传的 PDF 将自动带入版式预填值
                </p>
                <div className="label-template-options">
                  {LABEL_TEMPLATES.map((template) => (
                    <label
                      key={template.id}
                      className={`label-template-option ${
                        batch.layoutTemplateId === template.id ? 'active' : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="layout-template"
                        checked={batch.layoutTemplateId === template.id}
                        onChange={() => handleTemplateChange(template.id)}
                      />
                      <span className="option-title">{template.name}</span>
                      <span className="option-desc">{template.description}</span>
                    </label>
                  ))}
                </div>
              </section>

              <FieldListEditor
                title="发票头字段"
                hint="由版式定义，可按需微调显示名与键名"
                fields={batch.headerFields}
                onAdd={() => handleAddField('header')}
                onRemove={(id) => handleRemoveField('header', id)}
                onUpdate={(id, patch) => handleUpdateField('header', id, patch)}
              />
              <FieldListEditor
                title="子清单表格列"
                hint="由版式定义，用于「发票+子清单」结构的明细行"
                fields={batch.sublistColumns}
                onAdd={() => handleAddField('sublist')}
                onRemove={(id) => handleRemoveField('sublist', id)}
                onUpdate={(id, patch) => handleUpdateField('sublist', id, patch)}
              />
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
