import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCurrency,
  formatDate,
  formatMileage,
  parseDateString,
  todayString,
  vehicleTitle,
} from './format.js';

describe('formatCurrency', () => {
  it('formats numbers as USD with cents and grouping', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
    expect(formatCurrency(79.95)).toBe('$79.95');
  });

  it('formats zero as $0.00 (not a dash)', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('returns a dash for null, undefined, empty, and non-numeric values', () => {
    expect(formatCurrency(null)).toBe('—');
    expect(formatCurrency(undefined)).toBe('—');
    expect(formatCurrency('')).toBe('—');
    expect(formatCurrency('abc')).toBe('—');
  });
});

describe('formatMileage', () => {
  it('formats with thousands separators and a mi suffix', () => {
    expect(formatMileage(45210)).toBe('45,210 mi');
    expect(formatMileage(0)).toBe('0 mi');
  });

  it('returns a dash for missing values', () => {
    expect(formatMileage(null)).toBe('—');
    expect(formatMileage(undefined)).toBe('—');
    expect(formatMileage('')).toBe('—');
  });
});

describe('formatDate', () => {
  it('formats YYYY-MM-DD strings as a readable local date', () => {
    expect(formatDate('2024-03-09')).toBe('Mar 9, 2024');
    expect(formatDate('2026-12-31')).toBe('Dec 31, 2026');
  });

  it('does not shift the day across timezones (parses as local)', () => {
    // new Date('2024-01-01') would be UTC midnight and could render Dec 31.
    expect(formatDate('2024-01-01')).toBe('Jan 1, 2024');
  });

  it('returns a dash for null or garbage input', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('parseDateString', () => {
  it('parses to a local Date with the exact day', () => {
    const parsed = parseDateString('2025-07-04');
    expect(parsed.getFullYear()).toBe(2025);
    expect(parsed.getMonth()).toBe(6);
    expect(parsed.getDate()).toBe(4);
  });
});

describe('todayString', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(todayString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('vehicleTitle', () => {
  it('prefers the nickname', () => {
    expect(vehicleTitle({ name: 'Daily Driver', year: 2020, make: 'Honda', model: 'Civic' })).toBe(
      'Daily Driver'
    );
  });

  it('falls back to "year make model"', () => {
    expect(vehicleTitle({ name: null, year: 2019, make: 'Toyota', model: 'Corolla' })).toBe(
      '2019 Toyota Corolla'
    );
  });
});

describe('formatBytes', () => {
  it('renders bytes below 1 KB as B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('renders KB and MB with one decimal', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('renders GB with two decimals', () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.50 GB');
  });

  it('returns a dash for missing or invalid values', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes('')).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes('abc')).toBe('—');
  });
});
