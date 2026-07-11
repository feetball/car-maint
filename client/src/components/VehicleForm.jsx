import { useState } from 'react';

const EMPTY = {
  name: '',
  make: '',
  model: '',
  year: '',
  vin: '',
  license_plate: '',
  color: '',
  current_mileage: '',
  notes: '',
};

function toFormValues(vehicle) {
  if (!vehicle) return {};
  return {
    name: vehicle.name || '',
    make: vehicle.make || '',
    model: vehicle.model || '',
    year: vehicle.year != null ? String(vehicle.year) : '',
    vin: vehicle.vin || '',
    license_plate: vehicle.license_plate || '',
    color: vehicle.color || '',
    current_mileage: vehicle.current_mileage != null ? String(vehicle.current_mileage) : '',
    notes: vehicle.notes || '',
  };
}

export function validateVehicle(values) {
  const errors = {};
  if (!values.make.trim()) errors.make = 'Make is required';
  if (!values.model.trim()) errors.model = 'Model is required';
  if (String(values.year).trim() === '') {
    errors.year = 'Year is required';
  } else {
    const year = Number(values.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      errors.year = 'Enter a year between 1900 and 2100';
    }
  }
  if (String(values.current_mileage).trim() !== '') {
    const mileage = Number(values.current_mileage);
    if (!Number.isInteger(mileage) || mileage < 0) {
      errors.current_mileage = 'Mileage must be a whole number of 0 or more';
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

export default function VehicleForm({
  initial = null,
  onSubmit,
  onCancel,
  submitLabel = 'Save vehicle',
  busy = false,
  error = null,
}) {
  const [values, setValues] = useState(() => ({ ...EMPTY, ...toFormValues(initial) }));
  const [errors, setErrors] = useState({});

  function setField(name, value) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    const nextErrors = validateVehicle(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const payload = {
      name: values.name.trim() || null,
      make: values.make.trim(),
      model: values.model.trim(),
      year: Number(values.year),
      vin: values.vin.trim() || null,
      license_plate: values.license_plate.trim() || null,
      color: values.color.trim() || null,
      notes: values.notes.trim() || null,
    };
    if (String(values.current_mileage).trim() !== '') {
      payload.current_mileage = Number(values.current_mileage);
    }
    onSubmit(payload);
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="form-grid">
        <Field label="Nickname" hint="optional" full>
          <input
            type="text"
            value={values.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="e.g. The daily driver"
          />
        </Field>
        <Field label="Make" error={errors.make}>
          <input
            type="text"
            value={values.make}
            onChange={(e) => setField('make', e.target.value)}
            placeholder="Honda"
            aria-invalid={errors.make ? 'true' : undefined}
          />
        </Field>
        <Field label="Model" error={errors.model}>
          <input
            type="text"
            value={values.model}
            onChange={(e) => setField('model', e.target.value)}
            placeholder="Civic"
            aria-invalid={errors.model ? 'true' : undefined}
          />
        </Field>
        <Field label="Year" error={errors.year}>
          <input
            type="number"
            inputMode="numeric"
            value={values.year}
            onChange={(e) => setField('year', e.target.value)}
            placeholder="2021"
            aria-invalid={errors.year ? 'true' : undefined}
          />
        </Field>
        <Field label="Current mileage" hint="optional" error={errors.current_mileage}>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={values.current_mileage}
            onChange={(e) => setField('current_mileage', e.target.value)}
            placeholder="45210"
            aria-invalid={errors.current_mileage ? 'true' : undefined}
          />
        </Field>
        <Field label="VIN" hint="optional">
          <input
            type="text"
            value={values.vin}
            onChange={(e) => setField('vin', e.target.value)}
            placeholder="17 characters"
          />
        </Field>
        <Field label="License plate" hint="optional">
          <input
            type="text"
            value={values.license_plate}
            onChange={(e) => setField('license_plate', e.target.value)}
          />
        </Field>
        <Field label="Color" hint="optional">
          <input type="text" value={values.color} onChange={(e) => setField('color', e.target.value)} />
        </Field>
        <Field label="Notes" hint="optional" full>
          <textarea
            rows={3}
            value={values.notes}
            onChange={(e) => setField('notes', e.target.value)}
            placeholder="Anything worth remembering about this vehicle"
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
