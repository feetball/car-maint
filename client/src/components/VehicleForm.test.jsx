import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VehicleForm from './VehicleForm.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const VALID_VIN = '1HGBH41JXMN109186'; // 17 alphanumerics

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VehicleForm', () => {
  it('shows inline errors and blocks submit when required fields are missing', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /save vehicle/i }));

    expect(screen.getByText('Make is required')).toBeInTheDocument();
    expect(screen.getByText('Model is required')).toBeInTheDocument();
    expect(screen.getByText('Year is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range year and blocks submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/make/i), 'Honda');
    await user.type(screen.getByLabelText(/model/i), 'Civic');
    await user.type(screen.getByLabelText(/year/i), '1850');
    await user.click(screen.getByRole('button', { name: /save vehicle/i }));

    expect(screen.getByText('Enter a year between 1900 and 2100')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a negative mileage', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/make/i), 'Honda');
    await user.type(screen.getByLabelText(/model/i), 'Civic');
    await user.type(screen.getByLabelText(/year/i), '2021');
    await user.type(screen.getByLabelText(/current mileage/i), '-5');
    await user.click(screen.getByRole('button', { name: /save vehicle/i }));

    expect(
      screen.getByText('Mileage must be a whole number of 0 or more')
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits trimmed, typed values when valid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/make/i), '  Honda ');
    await user.type(screen.getByLabelText(/model/i), 'Civic');
    await user.type(screen.getByLabelText(/year/i), '2021');
    await user.type(screen.getByLabelText(/current mileage/i), '45210');
    await user.click(screen.getByRole('button', { name: /save vehicle/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        make: 'Honda',
        model: 'Civic',
        year: 2021,
        current_mileage: 45210,
      })
    );
    expect(screen.queryByText('Make is required')).not.toBeInTheDocument();
  });

  it('calls onCancel from the cancel button without submitting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe('Decode VIN', () => {
    it('keeps the decode button disabled until the VIN is 11–17 chars', async () => {
      const user = userEvent.setup();
      render(<VehicleForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

      const decodeButton = screen.getByRole('button', { name: /decode vin/i });
      expect(decodeButton).toBeDisabled();

      await user.type(screen.getByPlaceholderText('17 characters'), 'SHORT'); // 5 chars
      expect(decodeButton).toBeDisabled();

      await user.clear(screen.getByPlaceholderText('17 characters'));
      await user.type(screen.getByPlaceholderText('17 characters'), VALID_VIN);
      expect(decodeButton).toBeEnabled();
    });

    it('fills empty year/make/model and puts the trim in the nickname', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn(async () =>
        jsonResponse({ vin: VALID_VIN, year: 2021, make: 'Honda', model: 'Civic', trim: 'EX' })
      );
      vi.stubGlobal('fetch', fetchMock);

      render(<VehicleForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

      await user.type(screen.getByPlaceholderText('17 characters'), VALID_VIN);
      await user.click(screen.getByRole('button', { name: /decode vin/i }));

      await waitFor(() => expect(screen.getByLabelText(/make/i)).toHaveValue('Honda'));
      expect(screen.getByLabelText(/model/i)).toHaveValue('Civic');
      expect(screen.getByLabelText(/year/i)).toHaveValue(2021);
      expect(screen.getByLabelText(/nickname/i)).toHaveValue('EX');
      expect(fetchMock).toHaveBeenCalledWith(`/api/vin/${VALID_VIN}`, expect.anything());
    });

    it('never clobbers values the user already entered', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn(async () =>
        jsonResponse({ vin: VALID_VIN, year: 2021, make: 'Honda', model: 'Civic', trim: 'EX' })
      );
      vi.stubGlobal('fetch', fetchMock);

      render(<VehicleForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

      // User has a nickname and make already; model/year/notes are empty.
      await user.type(screen.getByLabelText(/nickname/i), 'My Car');
      await user.type(screen.getByLabelText(/make/i), 'Toyota');
      await user.type(screen.getByPlaceholderText('17 characters'), VALID_VIN);
      await user.click(screen.getByRole('button', { name: /decode vin/i }));

      // Empty fields get filled…
      await waitFor(() => expect(screen.getByLabelText(/model/i)).toHaveValue('Civic'));
      expect(screen.getByLabelText(/year/i)).toHaveValue(2021);
      // …but the user's own make and nickname survive, and the trim lands in notes.
      expect(screen.getByLabelText(/make/i)).toHaveValue('Toyota');
      expect(screen.getByLabelText(/nickname/i)).toHaveValue('My Car');
      expect(screen.getByLabelText(/notes/i)).toHaveValue('EX');
    });

    it('shows an inline error when decode fails and does not touch the fields', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn(async () =>
        jsonResponse({ error: 'VIN service unavailable' }, { ok: false, status: 502 })
      );
      vi.stubGlobal('fetch', fetchMock);

      render(<VehicleForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

      await user.type(screen.getByPlaceholderText('17 characters'), VALID_VIN);
      await user.click(screen.getByRole('button', { name: /decode vin/i }));

      expect(await screen.findByText('VIN service unavailable')).toBeInTheDocument();
      expect(screen.getByLabelText(/make/i)).toHaveValue('');
    });
  });
});
