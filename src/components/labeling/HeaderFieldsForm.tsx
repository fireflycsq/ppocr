import type { FieldDefinition } from '../../types'

interface HeaderFieldsFormProps {
  fields: FieldDefinition[]
  values: Record<string, string>
  onChange: (fieldId: string, value: string) => void
}

export function HeaderFieldsForm({ fields, values, onChange }: HeaderFieldsFormProps) {
  if (fields.length === 0) {
    return <p className="label-hint">请先在下方配置发票头字段</p>
  }

  return (
    <div className="label-field-values">
      {fields.map((field) => (
        <label key={field.id} className="field-label-input">
          <span>{field.label}</span>
          <input
            type="text"
            value={values[field.id] ?? ''}
            onChange={(e) => onChange(field.id, e.target.value)}
            placeholder={`填写 ${field.label}`}
          />
        </label>
      ))}
    </div>
  )
}
