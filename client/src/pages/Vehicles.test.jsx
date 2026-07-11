import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Vehicles from './Vehicles.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const sampleVehicles = [
  {
    id: 1,
    name: 'Daily Driver',
    make: 'Honda',
    model: 'Civic',
    year: 2020,
    vin: null,
    license_plate: null,
    color: 'Sonic Gray',
    current_mileage: 45210,
    notes: null,
    created_at: '2026-01-01 12:00:00',
    primary_photo: null,
    photo_count: 0,
    record_count: 3,
    total_cost: 412.5,
    last_service_date: '2026-06-01',
    alert_count: 2,
  },
  {
    id: 2,
    name: null,
    make: 'Toyota',
    model: 'Corolla',
    year: 2019,
    vin: null,
    license_plate: null,
    color: null,
    current_mileage: 80345,
    notes: null,
    created_at: '2025-12-01 12:00:00',
    primary_photo: null,
    photo_count: 0,
    record_count: 0,
    total_cost: 0,
    last_service_date: null,
    alert_count: 0,
  },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <Vehicles />
    </MemoryRouter>
  );
}

describe('Vehicles page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a card per vehicle from the API', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleVehicles));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    // Nickname used when present, "year make model" fallback otherwise.
    expect(await screen.findByText('Daily Driver')).toBeInTheDocument();
    expect(screen.getByText('2019 Toyota Corolla')).toBeInTheDocument();

    // Formatted mileage and totals.
    expect(screen.getByText('45,210 mi')).toBeInTheDocument();
    expect(screen.getByText('80,345 mi')).toBeInTheDocument();
    expect(screen.getByText('$412.50')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();

    // Alert badge only on the vehicle with alerts.
    expect(screen.getByTitle('2 reminders need attention')).toBeInTheDocument();

    // Cards link to the detail routes.
    const links = screen.getAllByRole('link');
    expect(links.some((l) => l.getAttribute('href') === '/vehicles/1')).toBe(true);
    expect(links.some((l) => l.getAttribute('href') === '/vehicles/2')).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith('/api/vehicles', expect.anything());
  });

  it('shows the empty state when there are no vehicles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));

    renderPage();

    expect(await screen.findByText('No vehicles yet')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /add your first vehicle/i })
    ).toBeInTheDocument();
  });

  it('surfaces the API error message in a banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'database is on fire' }, { ok: false, status: 500 }))
    );

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('database is on fire');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
