import { useState } from 'react';

function validate(values) {
  const errors = {};
  if (!values.type) errors.type = 'Choose a service type';
  const hasMonths = String(values.interval_months).trim() !== '';
  const hasMiles = String(values.interval_miles).trim() !== '';
  if (!hasMonths && !hasMiles) {
    errors.intervals = 'Set a time interval, a mileage interval, or both';
  }
  if (hasMonths) {
    const months = Number(values.interval_months);
    if (!Number.isInteger(months) || months < 1) {
      errors.interval_months = 'Months must be a whole number of 1 or more';
    }
  }
  if (hasMiles) {
    const miles = Number(values.interval_miles);
    if (!Number.isInteger(miles) || miles < 1) {
      errors.interval_miles = 'Miles must be a whole number of 1 or more';
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

export default function ReminderForm({
  initial = null,
  serviceTypes = [],
  onSubmit,
  onCancel,
  submitLabel = 'Save reminder',
  busy = false,
  error = null,
}) {
  const [values, setValues] = useState(() => ({
    type: initial?.type || '',
    description: initial?.description || '',
    interval_months: initial?.interval_months != null ? String(initial.interval_months) : '',
    interval_miles: initial?.interval_miles != null ? String(initial.interval_miles) : '',
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
      description: values.description.trim() || null,
      interval_months:
        String(values.interval_months).trim() === '' ? null : Number(values.interval_months),
      interval_miles:
        String(values.interval_miles).trim() === '' ? null : Number(values.interval_miles),
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
        <Field label="Service type" error={errors.type} full>
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
        <Field label="Every X months" hint="optional" error={errors.interval_months}>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            value={values.interval_months}
            onChange={(e) => setField('interval_months', e.target.value)}
            placeholder="6"
            aria-invalid={errors.interval_months ? 'true' : undefined}
          />
        </Field>
        <Field label="Every X miles" hint="optional" error={errors.interval_miles}>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            value={values.interval_miles}
            onChange={(e) => setField('interval_miles', e.target.value)}
            placeholder="5000"
            aria-invalid={errors.interval_miles ? 'true' : undefined}
          />
        </Field>
        {errors.intervals && (
          <p className="field__error field__error--standalone" role="alert">
            {errors.intervals}
          </p>
        )}
        <Field label="Description" hint="optional" full>
          <input
            type="text"
            value={values.description}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="e.g. Use full synthetic"
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
