import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecallsTab from './RecallsTab.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const sampleRecalls = {
  fetched_at: '2026-07-01',
  recalls: [
    {
      campaign_number: '21V123',
      component: 'SERVICE BRAKES, HYDRAULIC',
      summary: 'A brake line may corrode and leak fluid.',
      consequence: 'Increased stopping distance raises the risk of a crash.',
      remedy: 'Dealers will replace the brake lines free of charge.',
      report_date: '2021-03-15',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecallsTab', () => {
  it('lazily fetches and renders recall cards, reporting the count', async () => {
    const onCount = vi.fn();
    const fetchMock = vi.fn(async () => jsonResponse(sampleRecalls));
    vi.stubGlobal('fetch', fetchMock);

    render(<RecallsTab vehicleId={7} onCount={onCount} />);

    expect(await screen.findByText('21V123')).toBeInTheDocument();
    expect(screen.getByText('SERVICE BRAKES, HYDRAULIC')).toBeInTheDocument();
    expect(screen.getByText('A brake line may corrode and leak fluid.')).toBeInTheDocument();
    expect(
      screen.getByText('Increased stopping distance raises the risk of a crash.')
    ).toBeInTheDocument();
    expect(screen.getByText('Dealers will replace the brake lines free of charge.')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith('/api/vehicles/7/recalls', expect.anything());
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(1));
  });

  it('shows the empty state and reports zero when there are no recalls', async () => {
    const onCount = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ fetched_at: '2026-07-01', recalls: [] })));

    render(<RecallsTab vehicleId={7} onCount={onCount} />);

    expect(await screen.findByText('No open recalls — nice.')).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(0));
  });

  it('shows a distinct NHTSA-unreachable error state on upstream failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'NHTSA is not responding' }, { ok: false, status: 502 }))
    );

    render(<RecallsTab vehicleId={7} onCount={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/NHTSA unreachable/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('re-fetches with ?refresh=1 when the refresh button is clicked', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => jsonResponse(sampleRecalls));
    vi.stubGlobal('fetch', fetchMock);

    render(<RecallsTab vehicleId={7} onCount={vi.fn()} />);

    await screen.findByText('21V123');
    fetchMock.mockClear();

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/vehicles/7/recalls?refresh=1', expect.anything())
    );
  });
});
