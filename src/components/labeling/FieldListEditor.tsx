import type { FieldDefinition } from '../../types'

interface FieldListEditorProps {
  title: string
  hint?: string
  fields: FieldDefinition[]
  onAdd: () => void
  onRemove: (id: string) => void
  onUpdate: (id: string, patch: Partial<FieldDefinition>) => void
}

export function FieldListEditor({
  title,
  hint,
  fields,
  onAdd,
  onRemove,
  onUpdate,
}: FieldListEditorProps) {
  return (
    <section className="predefined-fields">
      <div className="predefined-fields-header">
        <div>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={onAdd}>
          + 添加
        </button>
      </div>

      {fields.length === 0 ? (
        <div className="label-empty-list">请至少添加一个字段</div>
      ) : (
        <ul className="predefined-field-list">
          {fields.map((field) => (
            <li key={field.id} className="predefined-field-row">
              <label className="field-label-input">
                <span>显示名</span>
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => onUpdate(field.id, { label: e.target.value })}
                  placeholder="字段名称"
                />
              </label>
              <label className="field-label-input">
                <span>键名</span>
                <input
                  type="text"
                  value={field.key}
                  onChange={(e) =>
                    onUpdate(field.id, {
                      key: e.target.value.replace(/\s/g, '_'),
                    })
                  }
                  placeholder="json_key"
                />
              </label>
              <button
                type="button"
                className="btn-icon btn-danger"
                title="删除字段"
                onClick={() => onRemove(field.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
