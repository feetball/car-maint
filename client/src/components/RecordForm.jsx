import { useState } from 'react';
import { todayString } from '../utils/format.js';

function validate(values) {
  const errors = {};
  if (!values.type) errors.type = 'Choose a service type';
  if (!values.date) {
    errors.date = 'Date is required';
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    errors.date = 'Use the YYYY-MM-DD format';
  }
  if (String(values.mileage).trim() !== '') {
    const mileage = Number(values.mileage);
    if (!Number.isInteger(mileage) || mileage < 0) {
      errors.mileage = 'Mileage must be a whole number of 0 or more';
    }
  }
  if (String(values.cost).trim() !== '') {
    const cost = Number(values.cost);
    if (Number.isNaN(cost) || cost < 0) {
      errors.cost = 'Cost must be 0 or more';
    }
  }
  return errors;
}

function Field({ label, hint, error, full, children }) {
  return (
    <label className={`field${full ? ' field--full' : ''}${error ? ' field--invalid' : ''}`}>
      <span className="field__label">
        {label}
        {hint && <em className="field__hint"> · {hint}</em>}
      </span>
      {children}
      {error && (
        <span className="field__error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export default function RecordForm({
  initial = null,
  serviceTypes = [],
  onSubmit,
  onCancel,
  submitLabel = 'Save record',
  busy = false,
  error = null,
}) {
  const [values, setValues] = useState(() => ({
    type: initial?.type || '',
    date: initial?.date || todayString(),
    description: initial?.description || '',
    mileage: initial?.mileage != null ? String(initial.mileage) : '',
    cost: initial?.cost != null ? String(initial.cost) : '',
    shop: initial?.shop || '',
    notes: initial?.notes || '',
  }));
  const [errors, setErrors] = useState({});

  function setField(name, value) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onSubmit({
      type: values.type,
      date: values.date,
      description: values.description.trim() || null,
      mileage: String(values.mileage).trim() === '' ? null : Number(values.mileage),
      cost: String(values.cost).trim() === '' ? null : Number(values.cost),
      shop: values.shop.trim() || null,
      notes: values.notes.trim() || null,
    });
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="form-grid">
        <Field label="Service type" error={errors.type}>
          <select
            value={values.type}
            onChange={(e) => setField('type', e.target.value)}
            aria-invalid={errors.type ? 'true' : undefined}
          >
            <option value="">Select a type…</option>
            {serviceTypes.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date" error={errors.date}>
          <input
            type="date"
            value={values.date}
            onChange={(e) => setField('date', e.target.value)}
            aria-invalid={errors.date ? 'true' : undefined}
          />
        </Field>
        <Field label="Mileage" hint="optional" error={errors.mileage}>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={values.mileage}
            onChange={(e) => setField('mileage', e.target.value)}
            placeholder="45210"
            aria-invalid={errors.mileage ? 'true' : undefined}
          />
        </Field>
        <Field label="Cost" hint="optional" error={errors.cost}>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={values.cost}
            onChange={(e) => setField('cost', e.target.value)}
            placeholder="79.95"
            aria-invalid={errors.cost ? 'true' : undefined}
          />
        </Field>
        <Field label="Description" hint="optional" full>
          <input
            type="text"
            value={values.description}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="e.g. Full synthetic 0W-20"
          />
        </Field>
        <Field label="Shop" hint="optional" full>
          <input
            type="text"
            value={values.shop}
            onChange={(e) => setField('shop', e.target.value)}
            placeholder="Who did the work?"
          />
        </Field>
        <Field label="Notes" hint="optional" full>
          <textarea
            rows={3}
            value={values.notes}
            onChange={(e) => setField('notes', e.target.value)}
          />
        </Field>
      </div>
      <div className="form-actions">
        <button type="button" className="button button--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
