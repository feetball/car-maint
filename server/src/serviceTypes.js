export const SERVICE_TYPES = [
  { value: 'oil_change', label: 'Oil Change' },
  { value: 'tire_rotation', label: 'Tire Rotation' },
  { value: 'new_tires', label: 'New Tires' },
  { value: 'brake_service', label: 'Brake Service' },
  { value: 'battery', label: 'Battery' },
  { value: 'air_filter', label: 'Engine Air Filter' },
  { value: 'cabin_filter', label: 'Cabin Air Filter' },
  { value: 'spark_plugs', label: 'Spark Plugs' },
  { value: 'coolant_flush', label: 'Coolant Flush' },
  { value: 'transmission', label: 'Transmission Service' },
  { value: 'alignment', label: 'Wheel Alignment' },
  { value: 'wiper_blades', label: 'Wiper Blades' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'registration', label: 'Registration' },
  { value: 'detailing', label: 'Detailing' },
  { value: 'repair', label: 'Repair' },
  { value: 'other', label: 'Other' },
];

export const SERVICE_TYPE_VALUES = new Set(SERVICE_TYPES.map((t) => t.value));

const LABELS = new Map(SERVICE_TYPES.map((t) => [t.value, t.label]));

export const labelFor = (value) => LABELS.get(value) ?? value;
