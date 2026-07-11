// Static mirror of GET /api/service-types (the API is the source of truth for
// form selects; this map is for labelling values that arrive on records and
// reminders without an extra round-trip, plus an offline fallback).
export const SERVICE_TYPE_LABELS = {
  oil_change: 'Oil Change',
  tire_rotation: 'Tire Rotation',
  new_tires: 'New Tires',
  brake_service: 'Brake Service',
  battery: 'Battery',
  air_filter: 'Engine Air Filter',
  cabin_filter: 'Cabin Air Filter',
  spark_plugs: 'Spark Plugs',
  coolant_flush: 'Coolant Flush',
  transmission: 'Transmission Service',
  alignment: 'Wheel Alignment',
  wiper_blades: 'Wiper Blades',
  inspection: 'Inspection',
  registration: 'Registration',
  detailing: 'Detailing',
  repair: 'Repair',
  other: 'Other',
};

export const FALLBACK_SERVICE_TYPES = Object.entries(SERVICE_TYPE_LABELS).map(
  ([value, label]) => ({ value, label })
);

export function typeLabel(value) {
  return SERVICE_TYPE_LABELS[value] || (value ? String(value).replace(/_/g, ' ') : 'Service');
}
