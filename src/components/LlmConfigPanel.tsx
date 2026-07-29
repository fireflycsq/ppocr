import { useEffect, useMemo, useState } from 'react'
import type { LlmExtractionConfig } from '../utils/llmConfig'
import {
  formatRequestJsonText,
  mergeRequestJsonOptions,
  parseOptionsJson,
  parseRequestJson,
} from '../utils/llmConfig'

interface LlmConfigPanelProps {
  config: LlmExtractionConfig
  /** Ollama 已安装的模型列表，用于提示 */
  models: string[]
  onChange: (patch: Partial<LlmExtractionConfig>) => void
  onReset: () => void
}

function optionsToText(options: unknown): string {
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    return JSON.stringify(options, null, 2)
  }
  return JSON.stringify({ temperature: 0 }, null, 2)
}

export function LlmConfigPanel({
  config,
  models,
  onChange,
  onReset,
}: LlmConfigPanelProps) {
  const [expanded, setExpanded] = useState(false)
  /** 编辑中不弹出红色错误，失焦后再校验展示，避免一改 JSON 就标红 */
  const [editing, setEditing] = useState(false)
  const [editingOptions, setEditingOptions] = useState(false)
  const [optionsText, setOptionsText] = useState('')
  const [optionsDirty, setOptionsDirty] = useState(false)
  const [optionsMergeError, setOptionsMergeError] = useState<string | null>(null)

  const parsed = useMemo(() => parseRequestJson(config.requestJson), [config.requestJson])
  const showError = Boolean(parsed.error) && !editing
  const parsedOptions = useMemo(
    () => parseOptionsJson(optionsText),
    [optionsText],
  )
  const showOptionsError = Boolean(parsedOptions.error) && !editingOptions

  useEffect(() => {
    // 未保存（包括暂时不合法）的草稿必须保留，不能被父级旧配置覆盖。
    if (editingOptions || optionsDirty) return
    if (parsed.body) {
      setOptionsText(optionsToText(parsed.body.options))
    }
  }, [config.requestJson, editingOptions, optionsDirty])

  const handleFormat = () => {
    if (!parsed.body) return
    onChange({ requestJson: formatRequestJsonText(parsed.body) })
  }

  const handleOptionsBlur = () => {
    setEditingOptions(false)
    setOptionsMergeError(null)
    const { options, error } = parseOptionsJson(optionsText)
    if (error || !options) return
    const merged = mergeRequestJsonOptions(config.requestJson, options)
    if (merged.error || !merged.requestJson) {
      setOptionsMergeError(merged.error)
      return
    }
    setOptionsText(optionsToText(options))
    setOptionsDirty(false)
    onChange({ requestJson: merged.requestJson })
  }

  const handleReset = () => {
    setEditingOptions(false)
    setOptionsDirty(false)
    setOptionsMergeError(null)
    onReset()
  }

  return (
    <section className="llm-config-panel">
      <button
        type="button"
        className="llm-config-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>
          大模型请求配置（模型：{parsed.model || '未设置'}）
          {showError && <span className="llm-config-error-tag">JSON 有误</span>}
        </span>
        <span>{expanded ? '收起' : '展开'}</span>
      </button>

      {expanded && (
        <div className="llm-config-body">
          <p className="llm-config-hint">
            推荐在下方「Ollama options」里增删参数（如{' '}
            <code>num_ctx</code>、<code>num_predict</code>
            ），会自动写回完整请求。Qwen3-VL 抽取请保持顶层{' '}
            <code>think: false</code>，且 <code>num_predict</code> 不小于 1024（默认
            4096），否则可能只返回思考过程而无 JSON 内容。
          </p>
          {models.length > 0 && (
            <p className="llm-config-hint">
              Ollama 已安装模型：{models.join('、')}
            </p>
          )}

          <label className="llm-config-field-label">Ollama options（JSON 对象）</label>
          <textarea
            className="llm-config-textarea llm-config-json llm-config-options"
            value={optionsText}
            onChange={(e) => {
              setOptionsText(e.target.value)
              setOptionsDirty(true)
              setOptionsMergeError(null)
            }}
            onFocus={() => setEditingOptions(true)}
            onBlur={handleOptionsBlur}
            spellCheck={false}
            rows={8}
          />
          {showOptionsError && (
            <p className="llm-config-error">{parsedOptions.error}</p>
          )}
          {optionsMergeError && (
            <p className="llm-config-error">{optionsMergeError}</p>
          )}

          <label className="llm-config-field-label">完整请求 JSON</label>
          <textarea
            className="llm-config-textarea llm-config-json"
            value={config.requestJson}
            onChange={(e) => onChange({ requestJson: e.target.value })}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            spellCheck={false}
            rows={22}
          />
          {showError && <p className="llm-config-error">{parsed.error}</p>}

          <div className="llm-config-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={!parsed.body}
              onClick={handleFormat}
            >
              格式化 JSON
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleReset}>
              恢复当前版式默认配置
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
